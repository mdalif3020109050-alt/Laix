const { createClient } = require('@supabase/supabase-js');

// Supabase ইনিশিয়ালাইজেশন (এনভায়রনমেন্ট ভেরিয়েবল থেকে)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey) : null;

// মডেল কনফিগারেশন এবং ফলব্যাক কিউ
const MODEL_CONFIGS = [
  {
    name: 'Gemini 3.5 Flash',
    apiName: 'gemini-1.5-flash',
    keyEnv: 'GOOGLE_API_KEY',
    endpoint: (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`
  },
  {
    name: 'Claude 3.5 Sonnet',
    apiName: 'claude-3-5-sonnet-20241022',
    keyEnv: 'CLAUDE_API_KEY',
    endpoint: () => 'https://api.anthropic.com/v1/messages',
    isClaude: true
  },
  {
    name: 'ChatGPT-4o',
    apiName: 'gpt-4o',
    keyEnv: 'OPENAI_API_KEY',
    endpoint: () => 'https://api.openai.com/v1/chat/completions',
    isOpenAi: true
  }
];

async function callModel(config, parts, question, lang) {
  const apiKey = process.env[config.keyEnv];
  if (!apiKey) {
    throw new Error(`${config.keyEnv} is not defined in environment variables.`);
  }

  let options = { method: 'POST', headers: {} };
  let body = {};

  if (config.isClaude) {
    options.headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    body = {
      model: config.apiName,
      max_tokens: 1500,
      messages: [{ role: 'user', content: question }]
    };
  } else if (config.isOpenAi) {
    options.headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };
    body = {
      model: config.apiName,
      messages: [{ role: 'user', content: question }]
    };
  } else {
    // Google Gemini Standard Payload
    options.headers = { 'Content-Type': 'application/json' };
    body = { contents: [{ parts: parts }] };
  }

  options.body = JSON.stringify(body);
  
  const response = await fetch(config.endpoint(apiKey), options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  // রেসপন্স পার্সিং
  if (config.isClaude && data.content && data.content[0]) {
    return data.content[0].text;
  } else if (config.isOpenAi && data.choices && data.choices[0]) {
    return data.choices[0].message.content;
  } else if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error("Invalid response format received from AI provider.");
}

exports.handler = async function(event, context) {
  // CORS হেডার্স
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method Not Allowed' })
    };
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: 'Invalid JSON format in request body' })
    };
  }

  const { question, imageBase64, mimeType, aiEngine, userId, earnedPoints, lang = 'bn' } = requestBody;

  if (!question && !imageBase64) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: 'Question or image is required.' })
    };
  }

  // Gemini পার্টস কনস্ট্রাক্ট করা
  const parts = [];
  if (question) {
    parts.push({ text: question });
  }
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: mimeType || 'image/jpeg',
        data: imageBase64
      }
    });
  }

  // এআই ইঞ্জিন ফলব্যাক লজিক (সিলেক্টেড ইঞ্জিন না থাকলে বা এরর করলে অন্যটিতে শিফট হবে)
  let selectedConfig = MODEL_CONFIGS.find(m => m.name === aiEngine) || MODEL_CONFIGS[0];
  let attemptQueue = [selectedConfig, ...MODEL_CONFIGS.filter(m => m !== selectedConfig)];

  let lastError = '';
  let successfulAnswer = '';
  let modelUsed = '';

  for (const config of attemptQueue) {
    try {
      successfulAnswer = await callModel(config, parts, question || "Analyze this attached image.", lang);
      modelUsed = config.name;
      break; // সফল হলে লুপ থামিয়ে দেব
    } catch (err) {
      console.warn(`Model ${config.name} failed: ${err.message}`);
      lastError = err.message;
    }
  }

  if (!successfulAnswer) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'All AI models failed to respond.',
        details: lastError
      })
    };
  }

  // যদি ব্যবহারকারী লগইন করা থাকে এবং পয়েন্ট আপডেট করতে হয়
  if (supabase && userId && earnedPoints) {
    try {
      let { data: existing } = await supabase
        .from('user_progress')
        .select('points')
        .eq('user_id', userId)
        .single();

      if (existing) {
        await supabase
          .from('user_progress')
          .update({ points: (existing.points || 0) + earnedPoints })
          .eq('user_id', userId);
      } else {
        await supabase
          .from('user_progress')
          .insert([{ user_id: userId, points: earnedPoints }]);
      }
    } catch (dbErr) {
      console.error("Supabase point update error:", dbErr.message);
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      model_used: modelUsed,
      answer: successfulAnswer
    })
  };
};
