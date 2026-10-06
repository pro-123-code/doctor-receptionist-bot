const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

const maxAudioSize = 25 * 1024 * 1024;
const maxConvertedSize = 32 * 1024 * 1024;

const nonRetryableVoiceErrorCodes = new Set([
  'VOICE_TRANSCRIPTION_NOT_ENABLED',
  'VOICE_TRANSCRIPTION_NOT_CONFIGURED',
  'VOICE_FORMAT_UNSUPPORTED',
  'VOICE_MEDIA_INVALID',
  'VOICE_MEDIA_UNAVAILABLE',
  'VOICE_TRANSCRIPT_EMPTY',
  'VOICE_CONVERTER_UNAVAILABLE',
  'VOICE_CONVERSION_FAILED',
  'VOICE_CONVERSION_TOO_LARGE'
]);

function isVoiceErrorRetryable(error) {
  const code = String(error?.code || '');
  const providerMatch = /^VOICE_PROVIDER_HTTP_(\d{3})$/.exec(code);
  if (providerMatch) {
    const status = Number(providerMatch[1]);
    return status === 429 || status >= 500;
  }
  if (nonRetryableVoiceErrorCodes.has(code)) return false;
  return true;
}

function convertWhatsAppAudioToWav(audioData, executable = ffmpegPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(executable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let outputSize = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      ffmpeg.kill();
      finish(Object.assign(new Error('Voice audio conversion timed out'), { code: 'VOICE_CONVERSION_TIMEOUT' }));
    }, 20_000);
    ffmpeg.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maxConvertedSize) {
        ffmpeg.kill();
        finish(Object.assign(new Error('Converted voice audio is too large'), { code: 'VOICE_CONVERSION_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    ffmpeg.once('error', () => finish(
      Object.assign(new Error('Voice audio converter is unavailable'), { code: 'VOICE_CONVERTER_UNAVAILABLE' })
    ));
    ffmpeg.once('close', (code) => {
      if (code !== 0 || outputSize <= 44) {
        finish(Object.assign(new Error('WhatsApp voice audio could not be converted'), { code: 'VOICE_CONVERSION_FAILED' }));
        return;
      }
      finish(null, Buffer.concat(chunks, outputSize));
    });
    ffmpeg.stdin.once('error', () => {});
    ffmpeg.stdin.end(audioData);
  });
}

function getVoiceFileExtension(mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const extensions = new Map([
    ['audio/ogg', 'ogg'],
    ['audio/opus', 'ogg'],
    ['audio/x-opus', 'ogg'],
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/mp4', 'm4a'],
    ['audio/x-m4a', 'm4a'],
    ['audio/aac', 'm4a'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/webm', 'webm'],
    ['audio/flac', 'flac']
  ]);
  const extension = extensions.get(mime);
  if (!extension) throw Object.assign(new Error('Unsupported WhatsApp voice format'), { code: 'VOICE_FORMAT_UNSUPPORTED' });
  return { extension, mime };
}

async function requestWhisperEndpoint(endpoint, wavData, environment, fetchImplementation) {
  const form = new FormData();
  form.append('file', new Blob([wavData], { type: 'audio/wav' }), 'whatsapp-voice.wav');
  form.append('model', environment.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1');
  form.append('prompt', 'WhatsApp voice note from a clinic patient, spoken in Urdu or English, about booking a doctor appointment.');

  let response;
  try {
    response = await fetchImplementation(`https://api.openai.com/v1/audio/${endpoint}`, {
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
  return typeof result.text === 'string' ? result.text.trim() : '';
}

async function translateVoiceMessageToEnglish(
  audioData, mimeType, environment = process.env, fetchImplementation = fetch,
  audioConverter = convertWhatsAppAudioToWav
) {
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

  getVoiceFileExtension(mimeType);
  let wavData;
  try {
    wavData = await audioConverter(audioData);
  } catch {
    throw Object.assign(new Error('WhatsApp voice audio could not be prepared for transcription'), {
      code: 'VOICE_CONVERSION_FAILED'
    });
  }

  // Primary: Whisper translation turns Urdu (or any language) speech into English text.
  // Fallback: plain transcription keeps English/Urdu speech usable if translation fails.
  let primaryError = null;
  try {
    const translated = await requestWhisperEndpoint('translations', wavData, environment, fetchImplementation);
    if (translated) return translated;
  } catch (error) {
    primaryError = error;
  }

  try {
    const transcribed = await requestWhisperEndpoint('transcriptions', wavData, environment, fetchImplementation);
    if (transcribed) return transcribed;
  } catch (error) {
    throw primaryError || error;
  }

  throw primaryError || Object.assign(new Error('Voice transcription returned no text'), { code: 'VOICE_TRANSCRIPT_EMPTY' });
}

module.exports = {
  convertWhatsAppAudioToWav,
  getVoiceFileExtension,
  isVoiceErrorRetryable,
  translateVoiceMessageToEnglish
};
