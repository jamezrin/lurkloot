// A typed table from effect type to the one handler that performs it (#599).
//
// Deciding code names effects; it never performs them. It yields an effect
// descriptor from a generator and is resumed with the handler's result, or
// with the handler's error thrown at the yield, so its own try/catch/finally
// still decide what a failure means. The driver below runs each yielded effect
// through the executor, in the order the generator yields them.
//
// Every effect type has exactly one handler at any time. An owner that takes an
// effect over replaces the interim handler's registration; it never adds a
// second one, so registering a type twice throws.

export interface Effect {
  readonly type: string;
}

// Maps each effect type to its descriptor and its result.
export type EffectCatalog = Record<string, { effect: Effect; result: unknown }>;

export type EffectHandler<C extends EffectCatalog, K extends keyof C, Context> = (
  effect: C[K]["effect"],
  context: Context,
) => Promise<C[K]["result"]> | C[K]["result"];

export class EffectExecutor<C extends EffectCatalog, Context> {
  private readonly handlers = new Map<keyof C, (effect: never, context: Context) => unknown>();

  register<K extends keyof C>(type: K, handler: EffectHandler<C, K, Context>): this {
    if (this.handlers.has(type)) throw new Error(`Effect "${String(type)}" already has a handler`);
    this.handlers.set(type, handler as (effect: never, context: Context) => unknown);
    return this;
  }

  has(type: keyof C): boolean {
    return this.handlers.has(type);
  }

  async run(effect: C[keyof C]["effect"], context: Context): Promise<unknown> {
    const handler = this.handlers.get(effect.type);
    if (!handler) throw new Error(`Effect "${effect.type}" has no handler`);
    return await handler(effect as never, context);
  }
}

// Yields one effect and returns its typed result: `const r = yield* perform(e)`.
export async function* perform<C extends EffectCatalog, K extends keyof C & string>(
  effect: C[K]["effect"] & { type: K },
): AsyncGenerator<C[keyof C]["effect"], C[K]["result"], unknown> {
  return (yield effect) as C[K]["result"];
}

// Runs a deciding generator to completion: every yielded effect goes through
// `run`, and its result (or error) resumes the generator. Once `signal` aborts,
// no further effect starts: the generator is closed (its `finally` blocks run)
// and the abort reason is thrown.
export async function driveEffects<E extends Effect, R>(
  generator: AsyncGenerator<E, R, unknown>,
  run: (effect: E) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<R> {
  let step = await generator.next();
  while (!step.done) {
    if (signal?.aborted) {
      await generator.return(undefined as R);
      signal.throwIfAborted();
    }
    let result: unknown;
    try {
      result = await run(step.value);
    } catch (error) {
      step = await generator.throw(error);
      continue;
    }
    step = await generator.next(result);
  }
  return step.value;
}
