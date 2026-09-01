export interface SmtpMessage {
  to: string
  from: string
  subject: string
  text: string
  html: string
}

export interface ServerPluginMailApi {
  smtp: {
    send: (message: SmtpMessage) => Promise<{ sent: true }>
  }
}
