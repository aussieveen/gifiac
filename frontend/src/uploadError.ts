/** `kind` lets callers tell "the connection dropped" or "the user cancelled"
 * from a server rejection without parsing the message; `status` is set for
 * `'http'` only. */
export class UploadError extends Error {
  kind: 'http' | 'network' | 'aborted'
  status?: number

  constructor(message: string, kind: 'http' | 'network' | 'aborted', status?: number) {
    super(message)
    this.name = 'UploadError'
    this.kind = kind
    this.status = status
  }
}
