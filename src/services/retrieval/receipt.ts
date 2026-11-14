import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ComemError } from '../../domain/errors.js';
import type { AssembledItem } from '../../domain/assembly.js';
import { Uri } from '../../domain/uri.js';
import { contentFingerprint, type DeliveredItem } from '../recall-ledger.js';
import type { DeliveryTracker } from './delivery.js';
import type { ContextOptions, DeliveryClock, SearchServiceDeps } from './types.js';

interface Receipt {
  readonly subject: string;
  readonly expiresAt: number;
  readonly clock?: DeliveryClock;
  readonly items: readonly DeliveredItem[];
}

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export class ContextReceipts {
  private readonly secret = randomBytes(32);

  constructor(private readonly deps: SearchServiceDeps, private readonly delivery: DeliveryTracker) {}

  issue(subject: string, clock: DeliveryClock | undefined, items: readonly AssembledItem[]): string | null {
    if (items.length === 0) return null;
    const receipt: Receipt = {
      subject, expiresAt: Date.now() + RECEIPT_TTL_MS, clock,
      items: items.map((item) => ({ uri: item.uri, detail: item.detail, fingerprint: contentFingerprint(item) })),
    };
    const payload = Buffer.from(JSON.stringify(receipt)).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }

  async acknowledge(token: string, identity: Pick<ContextOptions, 'subject' | 'principals'>): Promise<void> {
    const [payload, signature, extra] = token.split('.');
    if (payload === undefined || signature === undefined || extra !== undefined) throw this.invalid();
    const actual = Buffer.from(signature, 'base64url');
    const expected = this.sign(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw this.invalid();
    const receipt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Receipt;
    if (receipt.subject !== identity.subject || receipt.expiresAt <= Date.now()) throw this.invalid();
    const readable = await this.deps.authorizer.filterReadable(receipt.items.map((item) => Uri.parse(item.uri)), identity.principals);
    const excluded = await this.delivery.excluded(receipt.clock, receipt.items);
    const items = receipt.items.filter((item) => readable.has(item.uri) && !excluded?.has(item.uri));
    if (items.length === 0) return;
    await this.delivery.delivered(receipt.clock, items);
    this.delivery.recordHits(items);
  }

  private sign(payload: string): Buffer {
    return createHmac('sha256', this.secret).update(payload).digest();
  }

  private invalid(): ComemError {
    return new ComemError('INVALID_ARGUMENT', '上下文回执无效、已过期或不属于当前身份。', { reason: 'invalid_context_receipt' });
  }
}
