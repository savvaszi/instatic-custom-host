import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { getCachedPluginSettings } from '../../settingsCache'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'
import { sendSmtpMessage, type SmtpMessage } from '../smtp'

export async function handleMailSmtpSend(
  msg: ApiCallFor<'mail.smtp.send'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [message] = msg.args
  await sendSmtpMessage(getCachedPluginSettings(msg.pluginId), message as SmtpMessage)
  replyApiOk(msg.pluginId, msg.correlationId, { sent: true })
}
