export class ValidationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class AppServerError extends Error {
  constructor(message, { code = undefined, data = undefined, method = undefined } = {}) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityError";
  }
}
