require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// === MIDDLEWARE ===
// 2. Enable CORS for all routes
app.use(cors());

// Middleware to parse JSON bodies (Crucial for the /api/ai/ask route)
app.use(express.json());

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// === MONGODB SETUP ===
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Connected to MongoDB'))
  .catch((err) => console.error('🔴 MongoDB Connection Error:', err));

// 1. Schema for the Scraped News
const newsSchema = new mongoose.Schema({
  date: String,      
  category: String,  
  data: mongoose.Schema.Types.Mixed 
});
const NewsRecord = mongoose.model('NewsRecord', newsSchema);

// 2. Schema for the AI Cache (Survives Render restarts)
const cacheSchema = new mongoose.Schema({
  date: String,
  cacheName: String,
  expiresAt: Date
});
const AiCache = mongoose.model('AiCache', cacheSchema);


// === SCRAPER LOGIC ===
async function getCleanedHTML(url) {
  try {
    console.log(`🚀 Fetching: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000 
    });

    const $ = cheerio.load(response.data);

    $('noscript').each((i, el) => {
      const noscriptContent = $(el).text();
      if (noscriptContent && noscriptContent.includes('<img')) $(el).replaceWith(noscriptContent); 
    });

    $('img').each((i, el) => {
      const realImage = $(el).attr('data-src') || $(el).attr('data-original') || $(el).attr('data-lazy-src');
      if (realImage) $(el).attr('src', realImage); 
    });

    $('script, style, noscript, iframe, svg, header, footer, nav, aside').remove();
    
    $('*').each((i, el) => {
      const keep = ['href', 'src', 'alt', 'title', 'data-src', 'data-srcset', 'srcset'];
      const attributes = el.attribs;
      if (attributes) {
        Object.keys(attributes).forEach(attr => {
          if (!keep.includes(attr)) $(el).removeAttr(attr);
        });
      }
    });

    return `\n\n<div class="news-source">\n<h2>Source: ${url}</h2>\n${$.html()}\n</div>\n\n`;
  } catch (error) {
    console.error(`❌ Error fetching ${url}:`, error.message);
    return `<div class="news-source"><h2>Source: ${url}</h2><p>Failed to load.</p></div>`; 
  }
}

function extractNewsData(rawHtml) {
  const $ = cheerio.load(rawHtml);
  const allData = {};
  
  let sourceBlocks = $('.news-source').toArray();
  let isLiveSite = false;

  if (sourceBlocks.length === 0) {
      isLiveSite = true;
      sourceBlocks = [$('body')[0]]; 
  }

  let totalFound = 0;
  const junkDictionary = [
      'subscription', 'log in', 'sign in', 'read more', 'cricbuzz', 
      'newspaper', 'epaper', 'whats hot', 'crossword', 'newsletter',
      'live tv', 'podcasts', 'download app', 'coupondunia', 'techgig', 
      'timesjobs', 'bollywood news', 'times life', 'times pets', 'mylifexp',
      'listen to this', 'play game'
  ];

  sourceBlocks.forEach(blockEl => {
      const $block = $(blockEl);
      const baseUrl = isLiveSite 
          ? 'https://example.com' 
          : ($block.find('h2').first().text().replace('Source: ', '').trim() || 'https://example.com');
      
      let siteKey = 'UNKNOWN';
      const lowerUrl = baseUrl.toLowerCase();
      
      if (lowerUrl.includes('nytimes')) siteKey = 'NYT';
      else if (lowerUrl.includes('cnn')) siteKey = 'CNN';
      else if (lowerUrl.includes('indiatimes')) siteKey = 'TOI';
      else if (lowerUrl.includes('theguardian')) siteKey = 'Guardian';
      else if (lowerUrl.includes('aljazeera')) siteKey = 'AlJazeera';
      else if (lowerUrl.includes('nbcnews')) siteKey = 'NBC';
      else {
          try { siteKey = new URL(baseUrl).hostname.replace('www.', '').split('.')[0].toUpperCase(); } 
          catch (e) { siteKey = baseUrl.substring(0, 15); }
      }
      
      allData[siteKey] = { all: [], img: [], noImg: [], descImg: [], descNoImg: [], noDesc: [] };
      
      const seenLinks = new Set();
      const seenImages = new Set(); 
      const allElements = $block.find('*').toArray();
      const allImages = $block.find('img').toArray();
      const links = $block.find('a').toArray();

      links.forEach(link => {
          const $link = $(link);
          const rawHref = $link.attr('href');
          if (!rawHref || rawHref.includes('#') || rawHref.startsWith('javascript:')) return;

          let absoluteLink = rawHref;
          try { absoluteLink = new URL(rawHref, baseUrl).href; } catch (e) {}

          if (seenLinks.has(absoluteLink)) return;

          let headline = $link.find('h1, h2, h3, h4, h5, h6').first().text().trim() || $link.text().trim();
          if (!headline || headline.length < 15) {
              const $parent = $link.parent();
              if ($parent.length && $parent.find('a').length <= 8) headline = $parent.text().trim();
              else {
                  const $grandParent = $parent.parent();
                  if ($grandParent.length && $grandParent.find('a').length <= 8) headline = $grandParent.text().trim();
              }
          }

          headline = headline.replace(/\n/g, ' - ').replace(/\s+/g, ' ').trim();
          if (!headline || headline.length < 20 || headline.length > 250 || headline.split(' ').length < 3) return; 

          const lowerHeadline = headline.toLowerCase();
          if (junkDictionary.some(junkWord => lowerHeadline.includes(junkWord))) return;

          let bestImage = null;
          const checkAndClaimImage = (imgElement) => {
              if (!imgElement) return false;
              const $img = $(imgElement);
              let rawSrc = $img.attr('data-src') || $img.attr('src');
              if (!rawSrc && $img.attr('srcset')) rawSrc = $img.attr('srcset').split(',')[0].trim().split(' ')[0];
              if (!rawSrc && $img.attr('data-srcset')) rawSrc = $img.attr('data-srcset').split(',')[0].trim().split(' ')[0];

              if (!rawSrc) return false;
              const lowerSrc = rawSrc.toLowerCase();
              if (lowerSrc.includes('logo') || lowerSrc.includes('icon') || lowerSrc.includes('avatar') || lowerSrc.includes('author') || lowerSrc.includes('svg')) return false;

              let absoluteImg = rawSrc;
              try { absoluteImg = new URL(rawSrc, baseUrl).href; } catch (e) {}

              if (!seenImages.has(absoluteImg)) {
                  bestImage = absoluteImg;
                  seenImages.add(absoluteImg); 
                  return true;
              }
              return false; 
          };

          if (!checkAndClaimImage($link.find('img')[0])) {
              let $currentParent = $link.parent();
              let levelsClimbed = 0;
              let foundValidImage = false;

              while ($currentParent.length && levelsClimbed < 6) {
                  const uniqueHrefsInParent = new Set($currentParent.find('a').toArray().filter(a => $(a).text().trim().length > 10).map(a => $(a).attr('href')?.split('?')[0]));
                  if (uniqueHrefsInParent.size > 2) break; 

                  const imagesInBox = $currentParent.find('img').toArray();
                  for (let img of imagesInBox) {
                      if (checkAndClaimImage(img)) {
                          foundValidImage = true;
                          break; 
                      }
                  }
                  if (foundValidImage) break; 
                  $currentParent = $currentParent.parent();
                  levelsClimbed++;
              }

              if (!foundValidImage) {
                  const linkIndex = allElements.indexOf(link);
                  let minDistance = 40; 
                  let closestImgElement = null;

                  allImages.forEach(img => {
                      const imgIndex = allElements.indexOf(img);
                      const distance = Math.abs(linkIndex - imgIndex);
                      if (distance < minDistance) {
                          minDistance = distance;
                          closestImgElement = img;
                      }
                  });

                  if (closestImgElement) checkAndClaimImage(closestImgElement);
              }
          }

          let bestDescription = null;
          let $descParent = $link.parent();
          let descLevels = 0;

          while ($descParent.length && descLevels < 5) {
              const uniqueHrefsInParent = new Set($descParent.find('a').toArray().filter(a => $(a).text().trim().length > 10).map(a => $(a).attr('href')?.split('?')[0]));
              if (uniqueHrefsInParent.size > 2) break; 

              const pTags = $descParent.find('p').toArray();
              for (let p of pTags) {
                  let pText = $(p).text().replace(/\n/g, ' ').trim();
                  if (pText.length > 35 && pText !== headline && !headline.includes(pText) && !pText.includes(headline)) {
                      bestDescription = pText;
                      break;
                  }
              }
              if (bestDescription) break;

              const textChunks = $descParent.text().split('\n').map(t => t.trim());
              for (let chunk of textChunks) {
                  if (chunk.length > 40 && chunk !== headline && !headline.includes(chunk) && !chunk.includes(headline)) {
                      bestDescription = chunk;
                      break;
                  }
              }
              if (bestDescription) break;

              $descParent = $descParent.parent();
              descLevels++;
          }

          if (bestDescription && bestDescription.length > 150) bestDescription = bestDescription.substring(0, 147).trim() + "...";

          const hasValidImage = bestImage !== null;
          const hasValidDescription = bestDescription !== null;

          const articleObj = {
              h: headline,
              d: bestDescription,
              l: absoluteLink,
              i: bestImage 
          };

          allData[siteKey].all.push(articleObj);

          if (hasValidImage) {
              allData[siteKey].img.push(articleObj);
              if (hasValidDescription) allData[siteKey].descImg.push(articleObj);
          } else {
              allData[siteKey].noImg.push(articleObj);
              if (hasValidDescription) allData[siteKey].descNoImg.push(articleObj);
          }

          if (!hasValidDescription) allData[siteKey].noDesc.push(articleObj);
          
          seenLinks.add(absoluteLink);
          totalFound++;
      });
  });

  return allData; 
}

const CATEGORIES = {
  general: [
    'https://www.nytimes.com/',
    'https://edition.cnn.com/',
    'https://timesofindia.indiatimes.com/',
    'https://www.theguardian.com/international',
    'https://www.aljazeera.com/',
    'https://www.bbc.com/news',
    'https://www.nbcnews.com/'
  ],
  business: [
    'https://www.nytimes.com/section/business',
    'https://edition.cnn.com/business',
    'https://timesofindia.indiatimes.com/business',
    'https://www.theguardian.com/uk/business',
    'https://www.aljazeera.com/economy/',
    'https://www.bbc.com/business',
    'https://www.nbcnews.com/business'
  ],
  middleEast: [
    'https://www.nytimes.com/section/world/middleeast?page=3',
    'https://edition.cnn.com/world/middle-east',
    'https://timesofindia.indiatimes.com/world/middle-east',
    'https://www.theguardian.com/world/middleeast',
    'https://www.aljazeera.com/middle-east/',
    'https://www.bbc.com/news/world/middle_east',
    'https://www.nbcnews.com/news/mideast'
  ]
};

async function compileAllNews(urlsToScrape) {
  const promises = urlsToScrape.map(url => getCleanedHTML(url));
  const htmlSnippets = await Promise.all(promises);

  let combinedHTML = '<!DOCTYPE html>\n<html>\n<head>\n<title>All News Compilation</title>\n<meta charset="utf-8">\n</head>\n<body>\n';
  combinedHTML += htmlSnippets.join('\n');
  combinedHTML += '\n</body>\n</html>';

  return combinedHTML;
}


// === AI MINIFIER FUNCTION ===
// Converts massive JSON into flat, token-efficient text for Gemini
function minifyNewsForAI(allRecords) {
  let aiText = "DAILY NEWS CONTEXT:\n\n";

  allRecords.forEach(record => {
    const category = record.category;
    if (!record.data) return;

    Object.entries(record.data).forEach(([siteKey, siteData]) => {
      if (siteData.all && siteData.all.length > 0) {
        siteData.all.forEach(article => {
          const headline = article.h || '';
          const desc = article.d || '';
          if (headline) {
            aiText += `[${siteKey}] (${category}) ${headline} - ${desc}\n`;
          }
        });
      }
    });
  });

  return aiText;
}


// === ENDPOINTS ===

// 1. Sync Scraper Endpoint
app.get('/api/sync-database', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA'); 
    console.log(`\n🔄 Starting full database sync for ${today}...`);

    for (const [categoryName, urls] of Object.entries(CATEGORIES)) {
      console.log(`\n📂 Scraping category: ${categoryName.toUpperCase()}`);
      
      const rawCompiledHTML = await compileAllNews(urls);
      const structuredNewsData = extractNewsData(rawCompiledHTML);

      await NewsRecord.findOneAndUpdate(
        { date: today, category: categoryName }, 
        { data: structuredNewsData },            
        { upsert: true, new: true }              
      );

      console.log(`✅ Saved ${categoryName} data to MongoDB!`);
    }

    res.json({ message: `Success! Database synchronized for ${today}.` });

  } catch (error) {
    console.error('Database Sync Error:', error);
    res.status(500).json({ error: 'Failed to sync database' });
  }
});

// 2. Fetch specific category
app.get('/api/news', async (req, res) => {
  try {
    const requestedCategory = req.query.category || 'general';
    const today = new Date().toLocaleDateString('en-CA');
    const newsItem = await NewsRecord.findOne({ date: today, category: requestedCategory });

    if (newsItem) return res.json(newsItem.data);
    return res.status(404).json({ error: `No data found. Hit /api/sync-database first.` });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
});

// 3. Fetch all categories
app.get('/api/news/all', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA');
    const allRecords = await NewsRecord.find({ date: today });

    if (!allRecords || allRecords.length === 0) {
      return res.status(404).json({ error: 'No data found. Run /api/sync-database first.' });
    }

    const combinedData = {};
    allRecords.forEach(record => { combinedData[record.category] = record.data; });
    res.json(combinedData);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching all news' });
  }
});

// 4. Fetch by source (Fixed Case-Sensitivity)
app.get('/api/news/source/:siteKey', async (req, res) => {
  try {
    const requestedSite = req.params.siteKey.toUpperCase(); 
    const today = new Date().toLocaleDateString('en-CA');
    const allRecords = await NewsRecord.find({ date: today });

    let sourceArticles = { site: requestedSite, totalFound: 0, articles: [] };

    allRecords.forEach(record => {
      const categoryData = record.data;
      if (categoryData) {
        const actualKey = Object.keys(categoryData).find(
          key => key.toUpperCase() === requestedSite || key.toUpperCase().includes(requestedSite)
        );

        if (actualKey && categoryData[actualKey] && categoryData[actualKey].all) {
          categoryData[actualKey].all.forEach(article => {
            sourceArticles.articles.push({ ...article, category: record.category });
          });
        }
      }
    });

    sourceArticles.totalFound = sourceArticles.articles.length;
    res.json(sourceArticles);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching source news' });
  }
});

// 5. Search API
app.get('/api/news/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Please provide a search query (?q=apple)' });

    const searchKeyword = query.toLowerCase();
    const today = new Date().toLocaleDateString('en-CA');
    const allRecords = await NewsRecord.find({ date: today });
    const searchResults = [];

    allRecords.forEach(record => {
      Object.entries(record.data).forEach(([siteKey, siteData]) => {
        siteData.all.forEach(article => {
          const headline = article.h ? article.h.toLowerCase() : '';
          const desc = article.d ? article.d.toLowerCase() : '';
          if (headline.includes(searchKeyword) || desc.includes(searchKeyword)) {
            searchResults.push({ ...article, source: siteKey, category: record.category });
          }
        });
      });
    });

    res.json({ query: query, totalResults: searchResults.length, results: searchResults });
  } catch (error) {
    res.status(500).json({ error: 'Error searching news' });
  }
});

// 6. Featured API
app.get('/api/news/featured', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const today = new Date().toLocaleDateString('en-CA');
    const record = await NewsRecord.findOne({ date: today, category: 'general' });

    if (!record) return res.status(404).json({ error: 'No data found' });

    let premiumArticles = [];
    Object.entries(record.data).forEach(([siteKey, siteData]) => {
      if (siteData.descImg && siteData.descImg.length > 0) {
        const topFromSource = siteData.descImg.slice(0, 2).map(art => ({ ...art, source: siteKey }));
        premiumArticles.push(...topFromSource);
      }
    });

    premiumArticles = premiumArticles.sort(() => 0.5 - Math.random()).slice(0, limit);
    res.json(premiumArticles);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching featured news' });
  }
});


// === NEW AI ENDPOINTS ===

// AI Endpoint 1: Create the Cache (Run this via Cron job every 6-8 hours)
// AI ENDPOINT 1: Create the Cache
// app.get('/api/ai/update-cache', async (req, res) => {
//   try {
//     const today = new Date().toLocaleDateString('en-CA');
//     console.log(`\n🧠 Building AI Cache for ${today}...`);

//     const allRecords = await NewsRecord.find({ date: today });
//     if (!allRecords || allRecords.length === 0) {
//       return res.status(404).json({ error: 'No news in DB. Run /api/sync-database first.' });
//     }

//     const minifiedText = minifyNewsForAI(allRecords);
    
//     // Create the cache using the newest supported 2.0 model
//     const cache = await ai.caches.create({
//       model: 'gemini-2.0-flash', 
//       config: {
//         contents: [{ role: 'user', parts: [{ text: minifiedText }] }],
//         ttl: '28800s', // Lives for 8 hours
//       }
//     });

//     console.log(`✅ Cache created successfully: ${cache.name}`);

//     // Save cache details to MongoDB
//     await AiCache.findOneAndUpdate(
//       { date: today },
//       { cacheName: cache.name, expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000) },
//       { upsert: true, new: true }
//     );

//     res.json({ success: true, cacheName: cache.name });
//   } catch (error) {
//     console.error('Cache Creation Error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// // AI Endpoint 2: The Chat Interface for the Frontend
// app.post('/api/ai/ask', async (req, res) => {
//   try {
//     const { question } = req.body;
//     if (!question) return res.status(400).json({ error: 'Please provide a question.' });

//     const today = new Date().toLocaleDateString('en-CA');
//     const activeCache = await AiCache.findOne({ date: today });

//     if (!activeCache || !activeCache.cacheName) {
//       return res.status(503).json({ error: 'AI is updating its news knowledge. Please try again in a moment!' });
//     }

//     // Pass the question and the cacheName to Gemini
//     const response = await ai.models.generateContent({
//       model: 'gemini-1.5-flash',
//       contents: question,
//       config: {
//         cachedContent: activeCache.cacheName,
//         systemInstruction: "You are an expert news assistant. Answer the user's question clearly and concisely using ONLY the provided cached news data. If the answer cannot be found in the provided data, politely inform them that you do not have that information in today's news cycle."
//       }
//     });

//     res.json({ answer: response.text });
//   } catch (error) {
//     console.error('AI Chat Error:', error);
//     res.status(500).json({ error: 'Error generating AI response.' });
//   }
// });

// AI ENDPOINT: The Direct Chat Interface (No Caching Required)
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Please provide a question.' });

    const today = new Date().toLocaleDateString('en-CA');
    
    // 1. Grab today's news directly from the database
    const allRecords = await NewsRecord.find({ date: today });

    if (!allRecords || allRecords.length === 0) {
      return res.status(503).json({ error: 'The news database is currently empty for today. Please run the sync first!' });
    }

    // 2. Minify the data on the fly 
    const minifiedText = minifyNewsForAI(allRecords);

    // 3. Send the minified text and the question directly to Gemini
    // We use 1.5-flash here because it gives you 1,500 free requests per day!
   const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-preview', // <-- Updated to the newest, recognized model!
      contents: `Here is today's compiled news data: \n\n${minifiedText}\n\nUser Question: ${question}`,
      config: {
        systemInstruction: "You are an expert news assistant. Answer the user's question clearly and concisely using ONLY the provided news data. If the answer cannot be found in the provided data, politely inform them that you do not have that information in today's news cycle."
      }
    });

    res.json({ answer: response.text });

  } catch (error) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ error: 'Error generating AI response.' });
  }
});


// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});