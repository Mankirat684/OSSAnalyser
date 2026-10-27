require("dotenv").config();
const key = process.env.GEMINI_API_KEY;

async function testModel(model) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Return JSON: [{\"id\": 1}]" }] }]
      })
    });
    const d = await res.json();
    console.log(`[${model}] Elapsed: ${Date.now() - t0}ms, status:`, res.status, d.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 50) || d.error?.message?.slice(0, 80));
  } catch (err) {
    console.log(`[${model}] Error:`, err.message);
  }
}

async function run() {
  await testModel("gemini-flash-latest");
  await testModel("gemini-3.5-flash-lite");
  await testModel("gemini-2.5-flash-lite");
}
run();
