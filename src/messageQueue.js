const crypto = require('node:crypto');

const messageRetentionMs = 24 * 60 * 60 * 1000;
const lockDurationMs = 5 * 60 * 1000;
const maxAttempts = 3;

function getReceivedAt(timestamp, now = Date.now()) {
  if (timestamp instanceof Date && Number.isFinite(timestamp.getTime())) return timestamp;
  const numericTimestamp = typeof timestamp?.toNumber === 'function'
    ? timestamp.toNumber()
    : Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) return new Date(now);
  return new Date(numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp);
}

function getMessageId(message) {
  if (message.key?.id) return String(message.key.id);
  const fallback = `${message.key?.remoteJid || ''}:${message.messageTimestamp || ''}:${JSON.stringify(message.message || {})}`;
  return crypto.createHash('sha256').update(fallback).digest('hex');
}

async function enqueueInboundMessage(MessageModel, messageData) {
  const receivedAt = getReceivedAt(messageData.receivedAt);
  const record = {
    ...messageData,
    receivedAt,
    queuedAt: new Date(),
    expiresAt: new Date(receivedAt.getTime() + messageRetentionMs),
    status: 'pending'
  };
  delete record.message;

  try {
    return await MessageModel.findOneAndUpdate(
      { doctorId: record.doctorId, messageId: record.messageId },
      { $setOnInsert: record },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    return MessageModel.findOne({ doctorId: record.doctorId, messageId: record.messageId });
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function drainInboundQueue({
  MessageModel,
  QueueLockModel,
  doctorId,
  canProcess,
  processMessage,
  deliverReply,
  onFailure = () => {},
  responseDelayMs = 1500,
  now = Date.now
}) {
  if (!canProcess()) return 0;
  const ownerToken = crypto.randomUUID();
  const lockNow = new Date(now());
  let acquiredLock = await QueueLockModel.findOneAndUpdate(
    { doctorId, lockExpiresAt: { $lte: lockNow } },
    { $set: { ownerToken, lockExpiresAt: new Date(lockNow.getTime() + lockDurationMs) } },
    { new: true }
  );
  if (!acquiredLock) {
    try {
      acquiredLock = await QueueLockModel.create({
        doctorId,
        ownerToken,
        lockExpiresAt: new Date(lockNow.getTime() + lockDurationMs)
      });
    } catch (error) {
      if (error.code === 11000) return 0;
      throw error;
    }
  }

  let processedCount = 0;
  try {
    const cutoff = new Date(now() - messageRetentionMs);
    const expiredAt = new Date(now());
    await MessageModel.updateMany({
      doctorId,
      status: { $in: ['pending', 'processing', 'replying'] },
      receivedAt: { $lt: cutoff }
    }, {
      $set: { status: 'expired', processedAt: expiredAt, lastErrorCode: 'MESSAGE_EXPIRED' },
      $unset: { audioData: 1, text: 1 }
    });

    while (canProcess()) {
      const processingCutoff = new Date(now() - lockDurationMs);
      const message = await MessageModel.findOneAndUpdate({
        doctorId,
        receivedAt: { $gte: cutoff },
        $or: [
          { status: { $in: ['pending', 'replying'] } },
          { status: 'processing', processingStartedAt: { $lte: processingCutoff } }
        ]
      }, {
        $set: { status: 'processing', processingStartedAt: new Date(now()) },
        $inc: { attemptCount: 1 }
      }, {
        new: true,
        sort: { queuedAt: 1, _id: 1 }
      });
      if (!message) break;

      await QueueLockModel.updateOne({ doctorId, ownerToken }, {
        $set: { lockExpiresAt: new Date(now() + lockDurationMs) }
      });
      try {
        let reply = message.responseText;
        if (!reply) {
          reply = await processMessage(message);
          if (reply) {
            await MessageModel.updateOne({ _id: message._id, status: 'processing' }, {
              $set: { status: 'replying', responseText: reply }
            });
            message.responseText = reply;
            message.status = 'replying';
          }
        }
        if (reply && !canProcess()) throw Object.assign(new Error('WhatsApp session disconnected during processing'), { code: 'WHATSAPP_SESSION_OFFLINE' });
        if (reply) await deliverReply(message.senderJid, reply);
        await MessageModel.updateOne({ _id: message._id, status: reply ? 'replying' : 'processing' }, {
          $set: { status: 'completed', processedAt: new Date(now()) },
          $unset: { audioData: 1, text: 1, responseText: 1, processingStartedAt: 1 }
        });
      } catch (error) {
        const retry = message.attemptCount < maxAttempts;
        await MessageModel.updateOne({ _id: message._id, status: message.responseText ? 'replying' : 'processing' }, {
          $set: {
            status: retry ? (message.responseText ? 'replying' : 'pending') : 'failed',
            processedAt: retry ? null : new Date(now()),
            lastErrorCode: /^[A-Za-z0-9_-]{1,64}$/.test(String(error?.code || ''))
              ? String(error.code)
              : 'MESSAGE_PROCESSING_FAILED'
          },
          $unset: { processingStartedAt: 1, ...(retry ? {} : { audioData: 1, text: 1, responseText: 1 }) }
        });
        await onFailure(error, message, retry);
      }
      processedCount += 1;
      if (responseDelayMs > 0 && canProcess()) await wait(responseDelayMs);
    }
  } finally {
    await QueueLockModel.updateOne({ doctorId, ownerToken }, {
      $set: { lockExpiresAt: new Date(0) }
    });
  }
  return processedCount;
}

module.exports = { drainInboundQueue, enqueueInboundMessage, getMessageId, getReceivedAt, messageRetentionMs };