export type DocumentTicket = { document: number; revision: number };
export type LoadTicket = DocumentTicket & { request: number };

// 请求可以继续完成，但只能更新发起请求时的方案和版本。
export class DocumentSession {
  private document = 0;
  private revision = 0;
  private loadRequest = 0;

  edit() { this.revision += 1; }

  reset() {
    this.document += 1;
    this.revision = 0;
    this.loadRequest += 1;
  }

  capture(): DocumentTicket {
    return { document: this.document, revision: this.revision };
  }

  isSameDocument(ticket: DocumentTicket) {
    return ticket.document === this.document;
  }

  isUnchanged(ticket: DocumentTicket) {
    return this.isSameDocument(ticket) && ticket.revision === this.revision;
  }

  beginLoad(): LoadTicket {
    return { ...this.capture(), request: ++this.loadRequest };
  }

  isLatestLoad(ticket: LoadTicket) {
    return ticket.request === this.loadRequest && this.isSameDocument(ticket);
  }

  canApplyLoad(ticket: LoadTicket) {
    return this.isLatestLoad(ticket) && this.isUnchanged(ticket);
  }
}
