const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Error: GEMINI_API_KEY is not defined.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function main() {
  console.log("Querying available Gemini models...");
  
  // Try raw fetch using built-in Node.js fetch
  try {
    console.log("Attempting direct HTTP fetch to list models...");
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    
    if (data.error) {
      console.error("API Error Response:", JSON.stringify(data.error));
      return;
    }
    
    if (data.models) {
      console.log("HTTP list models success. Available generateContent models:");
      data.models.forEach(m => {
        if (m.supportedGenerationMethods.includes("generateContent")) {
          console.log(`- ${m.name} (${m.displayName})`);
        }
      });
    } else {
      console.log("HTTP response details:", JSON.stringify(data));
    }
  } catch (fetchErr) {
    console.error("HTTP fetch failed:", fetchErr.message);
  }
}

main();
