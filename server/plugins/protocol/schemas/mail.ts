import { Type } from '@sinclair/typebox'

export const MailSmtpSendArgSchema = Type.Object(
  {
    to: Type.String({ minLength: 3, maxLength: 320 }),
    from: Type.String({ minLength: 3, maxLength: 320 }),
    subject: Type.String({ minLength: 1, maxLength: 200 }),
    text: Type.String({ maxLength: 100_000 }),
    html: Type.String({ maxLength: 100_000 }),
  },
  { additionalProperties: false },
)
