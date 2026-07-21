export class CodexAgentMessageBuffer {
  private pendingMessage: string | undefined;
  private progressCount = 0;

  accept(message: string): string | undefined {
    const progressMessage = this.pendingMessage
      ? `${this.progressCount > 0 ? '\n\n' : ''}${this.pendingMessage}`
      : undefined;
    if (progressMessage) {
      this.progressCount++;
    }
    this.pendingMessage = message;
    return progressMessage;
  }

  finalize(): string | undefined {
    const finalMessage = this.pendingMessage;
    this.pendingMessage = undefined;
    return finalMessage;
  }
}
