import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type PendingRead = {
  resolve: (result: IteratorResult<SDKUserMessage>) => void;
};

/**
 * Long-lived input stream for one Claude SDK process.
 *
 * The Agent SDK treats a string prompt as a single-user-turn query and closes
 * the CLI process after its first `result`. A finite AsyncIterable has the same
 * problem: Query.streamInput() calls transport.endInput() as soon as that
 * iterable finishes. Claude Code then kills any local Bash/Agent tasks that
 * were still running.
 *
 * This stream yields the initial prompt, remains open across interim results,
 * and accepts follow-up messages until Build explicitly closes the turn after
 * final synthesis (or cancellation).
 */
export class ClaudePersistentInput implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
  private readonly initial: AsyncIterator<SDKUserMessage>;
  private initialComplete = false;
  private readonly queued: SDKUserMessage[] = [];
  private readonly pendingReads: PendingRead[] = [];
  private closed = false;

  constructor(initial: SDKUserMessage | AsyncIterable<SDKUserMessage>) {
    this.initial = ClaudePersistentInput.toIterable(initial)[Symbol.asyncIterator]();
  }

  private static async *toIterable(
    initial: SDKUserMessage | AsyncIterable<SDKUserMessage>,
  ): AsyncGenerator<SDKUserMessage> {
    if (Symbol.asyncIterator in Object(initial)) {
      yield* initial as AsyncIterable<SDKUserMessage>;
      return;
    }
    yield initial as SDKUserMessage;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  async next(): Promise<IteratorResult<SDKUserMessage>> {
    if (!this.initialComplete) {
      const initialResult = await this.initial.next();
      if (!initialResult.done) {
        return initialResult;
      }
      this.initialComplete = true;
    }

    const queued = this.queued.shift();
    if (queued) {
      return { value: queued, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
      this.pendingReads.push({ resolve });
    });
  }

  enqueue(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    const pending = this.pendingReads.shift();
    if (pending) {
      pending.resolve({ value: message, done: false });
    } else {
      this.queued.push(message);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingReads.splice(0)) {
      pending.resolve({ value: undefined, done: true });
    }
  }

  async return(): Promise<IteratorResult<SDKUserMessage>> {
    this.close();
    if (typeof this.initial.return === 'function') {
      await this.initial.return();
    }
    return { value: undefined, done: true };
  }
}
