/** 消费方契约：只声明方法，`GreetingPortImpl` 用 `implements` 接上。 */
export interface GreetingPort {
  greet(name: string): string;
  farewell(name: string): string;
}

export class GreetingPortImpl implements GreetingPort {
  greet(name: string): string {
    return `hi ${name}`;
  }

  farewell(name: string): string {
    return `bye ${name}`;
  }
}
