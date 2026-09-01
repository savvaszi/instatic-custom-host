import { describe, expect, it } from 'bun:test'
import { buildMimeMessage, validateSmtpConfig } from '../../../server/plugins/host/smtp'

describe('plugin SMTP host transport', () => {
  it('requires TLS and rejects private SMTP destinations', () => {
    expect(() => validateSmtpConfig({ smtpHost: 'localhost', smtpPort: 587, smtpTlsMode: 'starttls' }))
      .toThrow('smtp_delivery_failed')
    expect(() => validateSmtpConfig({ smtpHost: '192.168.1.10', smtpPort: 587, smtpTlsMode: 'starttls' }))
      .toThrow('smtp_delivery_failed')
    expect(() => validateSmtpConfig({ smtpHost: 'mail.example.com', smtpPort: 25, smtpTlsMode: 'plain' }))
      .toThrow('smtp_delivery_failed')
  })

  it('dot-stuffs message lines and rejects header injection', () => {
    const mime = buildMimeMessage({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Form submission',
      text: '.first line',
      html: '<p>Safe</p>',
    })
    expect(mime).toContain('\r\n..first line\r\n')
    expect(() => buildMimeMessage({
      to: 'recipient@example.com',
      from: 'sender@example.com',
      subject: 'Injected\r\nBcc: attacker@example.com',
      text: 'safe',
      html: '<p>safe</p>',
    })).toThrow('smtp_delivery_failed')
  })
})
