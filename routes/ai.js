const express = require("express");
const router = express.Router();
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.get("/generate-thought", async (req, res) => {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash", // OR use "gemini-pro" if it's available
    });

    const prompt = `
Generate a short, insightful, and unique AI-related thought that reflects real-world trends in the IT industry. 
It should sound like a tweet from a tech thought leader, be futuristic yet grounded in current advancements (e.g., machine learning, automation, AI ethics, software development, cloud computing, cybersecurity, etc.).
Keep it under 280 characters, add emojis for engagement, and avoid repetition or generic phrases.
`;

    const result = await model.generateContent(prompt);
    const response = result.response;

    const generatedText = await response.text(); // This is a string, NOT JSON

    res.json({ thought: generatedText }); // Send as a JSON object properly
  } catch (error) {
    console.error("Gemini API Error:", error.message);
    res.status(500).json({
      thought: "⚠️ AI is recharging... try again later!",
    });
  }
});

router.post("/suggest-message", async (req, res) => {
  const { from, to, previousMessages } = req.body;

  const chatHistory = previousMessages
    .map((msg) => `${msg.username === from ? "You" : to}: ${msg.message}`)
    .join("\n");

  const prompt = `
You are an AI assistant in a messaging app. Based on this chat between "${from}" and "${to}", generate 3 possible casual responses that "${from}" might send next. Keep the responses friendly and short (1-2 sentences). 

Chat history:
${chatHistory}

Now respond with only 3 replies, each on a new line. Do not number or label them. Just output the text replies.
`.trim();

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const raw = await response.text();

    // Clean output: split by lines, trim, and remove any numbered/bullet prefixes
    const options = raw
      .split("\n")
      .map((line) =>
        line
          .replace(/^[-*>.\d]+/, "") // remove bullet, >, numbers etc.
          .trim()
      )
      .filter((line) => line.length > 0);

    res.json({ suggestion: options.slice(0, 3) }); // return clean suggestions
  } catch (err) {
    console.error("AI Suggestion Error:", err);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});

module.exports = router;
