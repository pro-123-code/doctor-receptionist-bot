const maxAudioSize = 25 * 1024 * 1024;

function getVoiceFileExtension(mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const extensions = new Map([
    ['audio/ogg', 'ogg'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/mp4', 'm4a'],
    ['audio/x-m4a', 'm4a'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/webm', 'webm'],
    ['audio/flac', 'flac']
  ]);
  const extension = extensions.get(mime);
  if (!extension) throw Object.assign(new Error('Unsupported WhatsApp voice format'), { code: 'VOICE_FORMAT_UNSUPPORTED' });
  return { extension, mime };
}

async function translateVoiceMessageToEnglish(audioData, mimeType, environment = process.env, fetchImplementation = fetch) {
  if (environment.OPENAI_ALLOW_PHI_PROCESSING !== 'true') {
    throw Object.assign(new Error('Voice transcription is disabled until patient-data processing is approved'), {
      code: 'VOICE_TRANSCRIPTION_NOT_ENABLED'
    });
  }
  if (!environment.OPENAI_API_KEY) {
    throw Object.assign(new Error('Voice transcription is not configured'), { code: 'VOICE_TRANSCRIPTION_NOT_CONFIGURED' });
  }
  if (!Buffer.isBuffer(audioData) || audioData.length === 0 || audioData.length > maxAudioSize) {
    throw Object.assign(new Error('WhatsApp voice media is invalid or too large'), { code: 'VOICE_MEDIA_INVALID' });
  }

  const { extension, mime } = getVoiceFileExtension(mimeType);
  const form = new FormData();
  form.append('file', new Blob([audioData], { type: mime }), `whatsapp-voice.${extension}`);
  form.append('model', environment.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');

  let response;
  try {
    response = await fetchImplementation('https://api.openai.com/v1/audio/translations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(45_000)
    });
  } catch {
    throw Object.assign(new Error('Voice transcription provider is unavailable'), { code: 'VOICE_PROVIDER_UNAVAILABLE' });
  }
  if (!response.ok) {
    throw Object.assign(new Error('Voice transcription provider rejected the audio'), {
      code: `VOICE_PROVIDER_HTTP_${response.status}`
    });
  }

  const result = await response.json();
  if (typeof result.text !== 'string' || !result.text.trim()) {
    throw Object.assign(new Error('Voice transcription returned no text'), { code: 'VOICE_TRANSCRIPT_EMPTY' });
  }
  return result.text.trim();
}

module.exports = { getVoiceFileExtension, translateVoiceMessageToEnglish };