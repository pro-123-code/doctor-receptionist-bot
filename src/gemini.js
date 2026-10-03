const { GoogleGenAI, Type } = require('@google/genai');

function buildSystemInstruction(doctorProfile) {
  if (!doctorProfile?.doctorName || !doctorProfile?.clinicName || !Array.isArray(doctorProfile.facilitiesList)) {
    throw new Error('A complete doctor profile is required for Gemini prompting');
  }

  return [
    `You are the empathetic, professional AI receptionist for ${doctorProfile.doctorName} at ${doctorProfile.clinicName}.`,
    'Always use Roman Urdu or Roman English for patient-facing conversational responses.',
    `This clinic offers: ${doctorProfile.facilitiesList.join(', ')}.`,
    doctorProfile.welcomeMessage ? `Clinic welcome message: ${doctorProfile.welcomeMessage}` : '',
    'Collect symptoms/issues before appointment booking. Never diagnose, recommend treatment, or invent availability.',
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

async function generateJson(prompt, properties, required, doctorProfile) {
  if (!client) return null;

  const response = await client.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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

module.exports = { buildSystemInstruction, extractPatientField, extractSlotNumber };