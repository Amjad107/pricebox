require('dotenv').config();
const cors = require('cors');
app.use(cors());

const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const axios = require('axios');
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();
const app = express();
const port = process.env.PORT || 5000;
const fs = require('fs');
const { execSync } = require('child_process');
app.use(bodyParser.json());
const upload = multer({ storage: multer.memoryStorage() });
const FormData = require('form-data');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const taxRates = {
  "Palestine": 0.16,
  "United States": 0.07,
  "Germany": 0.19,
  "UK": 0.20,
  "France": 0.20,
  "India": 0.18,
  "Canada": 0.05
};
const cheerio = require('cheerio');

async function searchProductImage(product_name) {
  const query = encodeURIComponent(product_name);
  const url = `https://duckduckgo.com/?q=${query}&iax=images&ia=images`;

  try {
    const html = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const $ = cheerio.load(html.data);
    const imageScript = $('script')
      .toArray()
      .map((s) => $(s).html())
      .find((text) => text.includes('var o ='));

    const jsonMatch = imageScript.match(/var o = (\{.*?\});/);
    if (jsonMatch && jsonMatch[1]) {
      const imageData = JSON.parse(jsonMatch[1]);
      const imageUrl = imageData.results?.[0]?.image;
      return imageUrl || null;
    }

    return null;
  } catch (err) {
    console.error('DuckDuckGo image fetch error:', err.message);
    return null;
  }
}


async function getHSCode(product_name) {
  try {
    const prompt = `
    You are a customs expert. Give only the 6-digit HS Code for this product: "${product_name}". Only return the number.
    `;

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });

    const hs_code = gpt.choices[0].message.content.trim().match(/\d{6}/);
    return hs_code ? hs_code[0] : null;
  } catch (err) {
    console.error('HS code error:', err.message);
    return null;
  }
}

async function getProductImageFromGoogle(product_name) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  try {
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: apiKey,
        cx,
        q: product_name,
        searchType: 'image',
        num: 1
      }
    });

    const imageUrl = response.data.items?.[0]?.link;
    return imageUrl || null;
  } catch (err) {
    console.error("Google Image Search Error:", err.message);
    return null;
  }
}

app.post('/product-image', async (req, res) => {
  const { product_name } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: 'Missing product_name' });
  }

  const image_url = await getProductImageFromGoogle(product_name);

  res.json({
    product: product_name,
    image_url: image_url || "https://via.placeholder.com/300x300.png?text=Image+Not+Found"
  });
});

async function getTariff_US(hts_code) {
  try {
    const response = await axios.get(`https://hts.usitc.gov/api/hts?search=${hts_code}`);
    const results = response.data.results;
    const duty = results?.[0]?.duties?.[0]?.duty;
    
    if (duty && duty.includes('%')) {
      const rate = parseFloat(duty.replace('%', '')) / 100;
      return rate;
    }
    return null;
  } catch (err) {
    console.error('US HTS API error:', err.message);
    return null;
  }
}

function getTariff_WTO(hs_code, from_country, to_country) {
  const mockTariffs = {
    "851712": {
      "China": {
        "Palestine": 0.10,
        "USA": 0.15
      }
    }
  };

  return mockTariffs?.[hs_code]?.[from_country]?.[to_country] || null;
}

app.post('/final-result', upload.single('image'), async (req, res) => {
  try {
    const { text, barcode_data, image_url, address } = req.body;
    const imageFile = req.file;
    const result = {};

    console.log("📩 Input received:", { text, barcode_data, image_url, address });

    // Step 1: Agent 1 - Product Identification
    const agent1Res = await axios.post('http://localhost:5000/analyze', {
      text,
      barcode_data,
      image_url
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    // Declare product_name once
    let product_name;

    // Try extract from text
    if (agent1Res.data.result?.text_analysis?.toLowerCase().includes("product name")) {
      const match = agent1Res.data.result.text_analysis.match(/product name.*?:\s*(.*)/i);
      if (match) product_name = match[1].trim();
    }

    // Fallback to GPT image label
    if (!product_name && agent1Res.data.result?.image_analysis?.gpt_product_name) {
      product_name = agent1Res.data.result.image_analysis.gpt_product_name;
    }

    // Fallback to plain text
    if (!product_name && text) {
      product_name = text;
    }

    // Fallback to Agent 8 (image analysis)
    if ((!product_name || product_name === "Unknown") && imageFile) {
      const formData = new FormData();
      formData.append('image', imageFile.buffer, {
        filename: imageFile.originalname,
        contentType: imageFile.mimetype
      });

      const agent8Res = await axios.post(
        'http://localhost:5000/identify-product-from-image',
        formData,
        { headers: formData.getHeaders() }
      );

      product_name = agent8Res.data.product_name;
      result.agent8 = agent8Res.data;
    }

    if (!product_name) {
      product_name = "Unknown";
    }

    console.log("✅ Agent 1 Product Name:", product_name);

    // Step 2: Agent 2 - Address (manual or auto)
    const agent2Res = address
      ? { data: { ...address } }
      : await axios.get('http://localhost:5000/location');

    result.agent2 = agent2Res.data;

    if (!product_name || !result.agent2) {
      return res.status(400).json({ error: "Missing product_name or location" });
    }

    console.log("✅ Agent 2 Location:", result.agent2);

    // Step 3: Agent 3 - Product Price Info
    console.log("➡️ Calling Agent 3 with:", { product_name, location: result.agent2 });

    const agent3Res = await axios.post('http://localhost:5000/product-price', {
      product_name,
      location: result.agent2
    });

    result.agent3 = agent3Res.data;

    if (!result.agent3?.factory_price || isNaN(parseFloat(result.agent3.factory_price))) {
      return res.status(400).json({ error: "Invalid factory price from Agent 3" });
    }

    // Step 4: Agent 4 - Tariff Calculation
    console.log("➡️ Calling Agent 4 with:", {
      product_name,
      location: result.agent2,
      made_in: result.agent3.made_in,
      factory_price: result.agent3.factory_price
    });

    const agent4Res = await axios.post('http://localhost:5000/calculate-tariff', {
      product_name,
      location: result.agent2,
      made_in: result.agent3.made_in,
      factory_price: result.agent3.factory_price
    });

    result.agent4 = agent4Res.data;

    // Step 5: Agent 5 - Tax Calculation
    console.log("➡️ Calling Agent 5 with:", {
      product_name,
      location: result.agent2,
      factory_price: result.agent3.factory_price,
      tariff_amount: result.agent4.tariff_amount
    });

    const agent5Res = await axios.post('http://localhost:5000/calculate-tax', {
      product_name,
      location: result.agent2,
      factory_price: result.agent3.factory_price,
      tariff_amount: result.agent4.tariff_amount
    });

    result.agent5 = agent5Res.data;

    // Step 6: Agent 6 - Image Search
    console.log("➡️ Calling Agent 6 with:", { product_name });

    const agent6Res = await axios.post('http://localhost:5000/product-image', {
      product_name
    });

    result.agent6 = agent6Res.data;

    // Step 7: Final Combined Result
    return res.json({
      status: "success",
      product: product_name,
      address: result.agent2,
      made_in: result.agent3.made_in,
      factory_price: result.agent3.factory_price,
      prices: {
        lowest: result.agent3.lowest_price,
        highest: result.agent3.highest_price
      },
      tariff: result.agent4.summary,
      tax: result.agent5.summary,
      image_url: result.agent6.image_url
    });

  } catch (err) {
    console.error("❌ Agent 7 Error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "Agent 7 failed",
      details: err?.response?.data || err.message
    });
  }
});



async function estimateTariffWithAI(product_name, from_country, to_country) {
  try {
    const prompt = `
    Estimate the average import tariff rate (as a percentage) for importing "${product_name}" from ${from_country} to ${to_country}. 
    If unknown, reply with 0%.
    Return only the number with % symbol.
    `;

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });

    const match = gpt.choices[0].message.content.match(/(\d+)%/);
    return match ? parseFloat(match[1]) / 100 : 0;
  } catch (err) {
    console.error('Tariff estimate error:', err.message);
    return 0;
  }
}

app.post('/product-image', async (req, res) => {
  const { product_name } = req.body;

  if (!product_name) {
    return res.status(400).json({ error: 'Missing product_name' });
  }

  try {
const prompt = `
You are an AI image search assistant.

Your job is to return a single high-quality JPG or PNG product image URL for the following product:

"${product_name}"

This should be a direct link to an image file (ending in .jpg or .png), taken from a major store or manufacturer like Apple, Samsung, Amazon, BestBuy, or Walmart.

Do not explain anything. Just return the full direct image URL.
`;

    const gpt = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }]
    });

    const reply = gpt.choices[0].message.content.trim();
    const match = reply.match(/(https?:\/\/.*?\.(jpg|jpeg|png))/i);
    const image_url = match ? match[1] : null;

    res.json({
      product: product_name,
      image_url: image_url || "https://via.placeholder.com/300x300.png?text=Image+Not+Found"
    });

  } catch (err) {
    console.error("AI Agent 6 (OpenAI image URL) error:", err.message);
    res.status(500).json({ error: "Failed to retrieve product image" });
  }
});

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    const { text, barcode_data, image_url } = req.body;
    const result = {};

    // Text analysis with GPT
    if (text) {
      const gpt = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert product identifier. Extract product name, brand, category, and model from any description.',
          },
          {
            role: 'user',
            content: `Product description: ${text}`,
          },
        ],
      });

      result.text_analysis = gpt.choices[0].message.content;
    }

    // Image analysis from uploaded file (if no text)
    if (!text && req.file) {
      const filename = `temp-${Date.now()}.jpg`;
      fs.writeFileSync(filename, req.file.buffer);

      const [imageResult] = await visionClient.labelDetection(filename);
      const labels = imageResult.labelAnnotations.map(label => label.description);
      const label_summary = labels.slice(0, 5).join(', ');

      const gpt = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a product identification expert. From the following image labels, determine the most likely product name.'
          },
          {
            role: 'user',
            content: `Image labels: ${label_summary}`
          }
        ]
      });

      result.image_analysis = {
        labels,
        summary: label_summary,
        gpt_product_name: gpt.choices[0].message.content.trim()
      };

      fs.unlinkSync(filename);
    }

    // Image analysis from image URL
    if (image_url) {
      const [imageResult] = await visionClient.labelDetection(image_url);
      const labels = imageResult.labelAnnotations.map(label => label.description);
      result.image_analysis = {
        labels,
        summary: `Detected: ${labels.slice(0, 5).join(', ')}`
      };
    }

    // Barcode analysis
    if (barcode_data) {
      const zxingUrl = `https://zxing.org/w/decode?u=${encodeURIComponent(barcode_data)}`;
      result.barcode_analysis = `You submitted barcode data: ${barcode_data}. Try decoding via ZXing at: ${zxingUrl}`;
    }

    // Barcode scan from file
    if (req.file) {
      const filename = `temp-${Date.now()}.jpg`;
      fs.writeFileSync(filename, req.file.buffer);

      try {
        const output = execSync(`python barcode_reader.py ${filename}`, { encoding: 'utf-8' });
        result.barcode_analysis = JSON.parse(output);
      } catch (err) {
        result.barcode_analysis = { error: err.message };
      }

      fs.unlinkSync(filename);
    }

    res.json({ status: 'success', result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', error: err.message });
  }
});


app.post('/identify-product-from-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });

    const filename = `temp-${Date.now()}.jpg`;
    fs.writeFileSync(filename, req.file.buffer);

    const [imageResult] = await visionClient.labelDetection(filename);
    const labels = imageResult.labelAnnotations.map(label => label.description);
    const summary = labels.slice(0, 5).join(', ');

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a product recognition expert. From image labels, return the exact product name.'
        },
        {
          role: 'user',
          content: `Image labels: ${summary}`
        }
      ]
    });

    const product_name = gpt.choices[0].message.content.trim();
    fs.unlinkSync(filename);

    res.json({ product_name, labels });

  } catch (err) {
    console.error("Agent 8 Error:", err.message);
    res.status(500).json({ error: "Agent 8 failed", details: err.message });
  }
});




app.get('/location', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const geoRes = await axios.get(`http://ip-api.com/json/${ip}`);
    const { city, regionName, country, lat, lon, query } = geoRes.data;

    res.json({
      ip: query,
      city,
      region: regionName,
      country,
      lat,
      lon,
      full_address: `${city}, ${regionName}, ${country}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to detect location', details: err.message });
  }
});

app.get('/reverse-geocode', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  try {
    const googleApiKey = process.env.GOOGLE_MAPS_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${googleApiKey}`;
    const response = await axios.get(url);

    const address = response.data.results?.[0]?.formatted_address || 'Address not found';

    res.json({
      lat,
      lng,
      address
    });
  } catch (err) {
    res.status(500).json({ error: 'Reverse geocoding failed', details: err.message });
  }
});

app.post('/product-price', async (req, res) => {
  const { product_name, location } = req.body;

  if (!product_name || !location) {
    return res.status(400).json({ error: 'Missing product_name or location' });
  }

  const prompt = `
You are a global product pricing assistant.

Your task is to return a clean JSON object with the following fields for the product: "${product_name}".

{
  "made_in": "Country where the product is manufactured",
  "factory_price": "Estimated factory cost in USD (as a string)",
  "lowest_price": { "price": "Lowest retail price in USD", "store": "Store name" },
  "highest_price": { "price": "Highest retail price in USD", "store": "Store name" }
}

⚠️ Output ONLY the JSON object. Do not include any explanation or commentary.

If any value is unavailable, estimate it realistically. Only return "Unknown" or "00" if there's no information at all.
`;


  try {
    const gpt = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });

    let data = {};
    try {
      data = JSON.parse(gpt.choices[0].message.content);
    } catch (err) {
      console.error("Failed to parse GPT output:", err.message);
      data = {
        made_in: "Unknown",
        factory_price: "00",
        lowest_price: { price: "00", store: "Not found" },
        highest_price: { price: "00", store: "Not found" }
      };
    }

    res.json({
      product: product_name,
      location,
      ...data
    });

  } catch (err) {
    console.error("GPT error:", err.message);
    res.status(500).json({
      error: 'Failed to fetch product details',
      fallback: {
        product: product_name,
        made_in: "Unknown",
        factory_price: "00",
        lowest_price: { price: "00", store: "Not found" },
        highest_price: { price: "00", store: "Not found" }
      }
    });
  }
});

app.post('/calculate-tariff', async (req, res) => {
  const { product_name, location, made_in, factory_price } = req.body;
  console.log("TARIFF CALC INPUT:", req.body);

  if (!product_name || !location || !made_in || !factory_price) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let hs_code = await getHSCode(product_name);
  if (!hs_code) hs_code = "000000";

  let rate = null;

  // 1. Try US HTS API
  if (location.country.toLowerCase() === 'united states') {
    rate = await getTariff_US(hs_code);
  }

  // 2. Try local WTO DB
  if (!rate) {
    rate = getTariff_WTO(hs_code, made_in, location.country);
  }

  // 3. Try AI estimate
  if (!rate) {
    rate = await estimateTariffWithAI(product_name, made_in, location.country);
  }

  // 4. If still not found
  if (!rate || rate === 0) {
    return res.json({
      product: product_name,
      hs_code,
      from: made_in,
      to: location.country,
      tariff_rate: "unknown",
      tariff_amount: "00",
      summary: "unknown - $00.00"
    });
  }

  const amount = parseFloat(factory_price) * rate;

  res.json({
    product: product_name,
    hs_code,
    from: made_in,
    to: location.country,
    tariff_rate: `${(rate * 100).toFixed(0)}%`,
    tariff_amount: amount.toFixed(2),
    summary: `${(rate * 100).toFixed(0)}% - $${amount.toFixed(2)}`
  });
});

app.post('/calculate-tax', async (req, res) => {
  const { product_name, location, factory_price, tariff_amount } = req.body;
  console.log("TAX CALC INPUT:", req.body);

  if (!product_name || !location?.country || !factory_price || tariff_amount == null) {
    return res.status(400).json({ error: 'Missing required data from agents' });
  }

  const country = location.country;
  const taxRate = taxRates[country] || 0; // fallback = 0 if not found
  const priceAfterTariff = parseFloat(factory_price) + parseFloat(tariff_amount);
  const taxAmount = priceAfterTariff * taxRate;

  res.json({
    product: product_name,
    country,
    tax_rate: `${(taxRate * 100).toFixed(0)}%`,
    tax_amount: taxAmount.toFixed(2),
    summary: `${(taxRate * 100).toFixed(0)}% - $${taxAmount.toFixed(2)}`
  });
});


async function getTaxRateFromVATLayer(countryCode) {
  try {
    const vatKey = process.env.VATLAYER_API_KEY;
    if (!vatKey) return null;

    const response = await axios.get(`http://apilayer.net/api/rate`, {
      params: {
        access_key: vatKey,
        country_code: countryCode
      }
    });

    const rate = response.data?.standard_rate;
    return rate ? parseFloat(rate) / 100 : null;
  } catch (err) {
    console.error("VATLayer error:", err.message);
    return null;
  }
}
async function getTaxRateFromGPT(country) {
  try {
    const prompt = `
What is the current consumer tax rate (VAT or sales tax) in ${country} as of 2025?
Only return the number as a percentage like "15%".`;

    const gpt = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });

    const match = gpt.choices[0].message.content.match(/(\d+(\.\d+)?)%/);
    return match ? parseFloat(match[1]) / 100 : null;
  } catch (err) {
    console.error("GPT Tax fallback error:", err.message);
    return null;
  }
}
async function getBestTaxRate(country, countryCode) {
  let rate = await getTaxRateFromVATLayer(countryCode);
  if (rate != null) return rate;

  rate = await getTaxRateFromGPT(country);
  if (rate != null) return rate;

  return null;
}
app.post('/calculate-tax', async (req, res) => {
  const { product_name, location, factory_price, tariff_amount } = req.body;

  if (!product_name || !location?.country || !factory_price || tariff_amount == null) {
    return res.status(400).json({ error: 'Missing required product or location data' });
  }

  const country = location.country;
  const countryCode = location.country_code || ''; // Optional ISO code if you pass it

  const taxRate = await getBestTaxRate(country, countryCode);

  if (taxRate == null) {
    return res.json({
      product: product_name,
      country,
      tax_rate: "unknown",
      tax_amount: "00",
      summary: "unknown - $00.00"
    });
  }

  const priceAfterTariff = parseFloat(factory_price) + parseFloat(tariff_amount);
  const taxAmount = priceAfterTariff * taxRate;

  res.json({
    product: product_name,
    country,
    tax_rate: `${(taxRate * 100).toFixed(0)}%`,
    tax_amount: taxAmount.toFixed(2),
    summary: `${(taxRate * 100).toFixed(0)}% - $${taxAmount.toFixed(2)}`
  });
});


app.listen(port, () => {
  console.log(`AI Agent 1 API running at http://localhost:${port}`);
});
