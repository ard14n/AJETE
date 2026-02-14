import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const run = async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    console.log("API Key length:", apiKey?.length);

    if (!apiKey) {
        console.error("No API Key found!");
        return;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        // Try the model we are using in agent.ts
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        console.log("Generating content...");
        const result = await model.generateContent("Hello, are you working?");
        console.log("Response:", result.response.text());
        console.log("✅ Gemini API is working!");
    } catch (e: any) {
        console.error("❌ Gemini API Error:", e.message);
        if (e.response) {
            console.error("Details:", JSON.stringify(e.response, null, 2));
        }
    }
};

run();
