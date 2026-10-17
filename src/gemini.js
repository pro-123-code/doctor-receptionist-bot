const { GoogleGenAI, Type } = require('@google/genai');

// Whether Gemini extraction is available, and exactly what is missing if it is not.
// Read from the environment on every call so a redeployed configuration is reflected
// without relying on module load order.
function isGeminiEnabled(environment = process.env) {
  const hasKey = Boolean(String(environment.GEMINI_API_KEY ?? '').trim());
  const consent = String(environment.GEMINI_ALLOW_PHI_PROCESSING ?? '').trim().toLowerCase() === 'true';
  const missing = [];
  if (!hasKey) missing.push('GEMINI_API_KEY');
  if (!consent) missing.push('GEMINI_ALLOW_PHI_PROCESSING');
  return { enabled: missing.length === 0, hasKey, consent, missing };
}

function buildSystemInstruction(doctorProfile) {
  const name = String(doctorProfile?.doctorName || '').trim();
  const clinic = String(doctorProfile?.clinicName || '').trim();
  // A profile that has not finished setup is normal, not an error. Throwing here
  // made every extraction call fail for a clinic without priced items yet, which
  // was reported as a Gemini failure rather than as a missing profile field.
  const facilities = Array.isArray(doctorProfile?.facilitiesList) ? doctorProfile.facilitiesList : [];
  const services = Array.isArray(doctorProfile?.servicesList) ? doctorProfile.servicesList : [];

  return [
    `You are the empathetic, professional AI receptionist for ${name || 'this clinic'}${clinic ? ` at ${clinic}` : ''}.`,
    'Always use Roman Urdu or Roman English for patient-facing conversational responses.',
    facilities.length ? `This clinic offers: ${facilities.join(', ')}.` : 'This clinic has not published its facilities yet.',
    services.length ? `Treatments and services: ${services.join(', ')}.` : '',
    doctorProfile.consultationDetails ? `Consultation details: ${doctorProfile.consultationDetails}` : '',
    doctorProfile.welcomeMessage ? `Clinic welcome message: ${doctorProfile.welcomeMessage}` : '',
    'Only describe services and consultation details supplied in this clinic profile. Collect symptoms/issues before appointment booking. Never diagnose, recommend treatment, or invent availability.',
    'The application constructs all patient-facing replies. For this request, perform only the structured extraction described in the user prompt.',
    'Return only valid JSON matching the supplied responseSchema. Do not return conversational text, Markdown, or extra fields.'
  ].filter(Boolean).join(' ');
}

const allowPatientData = process.env.GEMINI_ALLOW_PHI_PROCESSING === 'true';
const client = process.env.GEMINI_API_KEY && allowPatientData
  ? new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { timeout: 8000 }
  })
  : null;
const configuredModel = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

async function generateJson(prompt, properties, required, doctorProfile) {
  if (!client) return null;

  const response = await client.models.generateContent({
    model: configuredModel(),
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: 120,
      systemInstruction: buildSystemInstruction(doctorProfile),
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties,
        required
      }
    }
  });

  if (typeof response.text !== 'string' || !response.text.trim()) {
    throw new Error('Gemini returned an empty structured response');
  }
  return JSON.parse(response.text);
}

async function extractPatientField(step, message, doctorProfile) {
  const fieldNames = {
    name: 'patient name',
    contactNumber: 'contact phone number',
    majorSymptoms: 'symptoms or reason for the visit'
  };
  const fieldName = fieldNames[step];
  if (!fieldName || !client) return null;

  const result = await generateJson(
    `Extract only the explicitly provided ${fieldName} from this message. Do not infer, add facts, diagnose, or give advice. Preserve the user's wording where possible. Return an empty value if it is not explicit.\nMessage: ${message}`,
    { value: { type: Type.STRING } },
    ['value'],
    doctorProfile
  );
  return typeof result?.value === 'string' && result.value.trim()
    ? result.value.trim()
    : null;
}

async function extractSlotNumber(message, slots, formatSlot, doctorProfile) {
  if (!client) return null;

  const availableOptions = slots.map((slot, index) => `${index + 1}: ${formatSlot(slot, index)}`).join('\n');
  const result = await generateJson(
    `Match the user's appointment choice to one of the numbered options. Return 0 unless the message clearly selects one option. Do not invent availability or change any option.\nOptions:\n${availableOptions}\nUser message: ${message}`,
    { slotNumber: { type: Type.INTEGER } },
    ['slotNumber'],
    doctorProfile
  );
  return Number.isInteger(result?.slotNumber) ? result.slotNumber : null;
}

// Reports whether extraction can run and, when it is enabled, proves the provider
// answers. Nothing about the key is returned. Uses a prompt with no patient data so
// this can be run safely from the dashboard.
async function diagnoseGemini(environment = process.env) {
  const status = isGeminiEnabled(environment);
  const stages = [];
  const record = (stage, ok, detail) => { stages.push({ stage, ok, detail }); };

  if (!status.hasKey) record('configuration', false, 'GEMINI_API_KEY is not set.');
  else if (!status.consent) record('configuration', false, 'GEMINI_ALLOW_PHI_PROCESSING must be exactly true.');
  else record('configuration', true, 'API key present and patient-data processing approved.');

  if (!status.enabled) {
    record('provider', false, 'Extraction is disabled, so the provider was not called.');
    return { enabled: false, ready: false, stages, model: configuredModel() };
  }

  record('provider', true, `Model ${configuredModel()}.`);
  try {
    const result = await extractPatientField('name', 'My name is Test Patient', {
      doctorName: 'Diagnostic', clinicName: 'Diagnostic Clinic', facilitiesList: [], servicesList: []
    });
    if (typeof result === 'string' && result.trim()) {
      record('response', true, 'The provider returned a structured extraction.');
      return { enabled: true, ready: true, stages, model: configuredModel() };
    }
    record('response', false, 'The provider answered but returned no value for a clear test input.');
    return { enabled: true, ready: false, stages, model: configuredModel() };
  } catch (error) {
    const message = String(error?.message || error);
    record('response', false, /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|403/i.test(message)
      ? 'The API key was rejected by Google. Check GEMINI_API_KEY.'
      : /model.*not found|404/i.test(message)
        ? `The model ${configuredModel()} is unavailable. Set GEMINI_MODEL to a model your key can use.`
        : message);
    return { enabled: true, ready: false, stages, model: configuredModel() };
  }
}

module.exports = { buildSystemInstruction, diagnoseGemini, extractPatientField, extractSlotNumber, isGeminiEnabled };