const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// === MONGODB SETUP ===
// Replace with your actual MongoDB connection string from MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || 'database uri';

mongoose.connect(MONGO_URI)
  .then(() => console.log('🟢 Connected to MongoDB'))
  .catch((err) => console.error('🔴 MongoDB Connection Error:', err));

// Define how the data looks in the database
const newsSchema = new mongoose.Schema({
  date: String,      // Will store as 'YYYY-MM-DD'
  category: String,  // 'general', 'business', etc.
  data: mongoose.Schema.Types.Mixed // Allows us to store your massive nested JSON object
});

const NewsRecord = mongoose.model('NewsRecord', newsSchema);


// === SCRAPER LOGIC ===
// 1. Fetch and clean the HTML
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

// 2. Extract structured data
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


// 3. THE CATEGORIES DICTIONARY
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


// === ENDPOINTS ===

// ENDPOINT 1: THE SCRAPER SYNC (Hit this to trigger the database update)
app.get('/api/sync-database', async (req, res) => {
  try {
    // Generate a clean 'YYYY-MM-DD' string based on today's local date
    const today = new Date().toLocaleDateString('en-CA'); 

    console.log(`\n🔄 Starting full database sync for ${today}...`);

    // Loop through the categories ONE BY ONE to protect Render RAM limits
    for (const [categoryName, urls] of Object.entries(CATEGORIES)) {
      console.log(`\n📂 Scraping category: ${categoryName.toUpperCase()}`);
      
      const rawCompiledHTML = await compileAllNews(urls);
      const structuredNewsData = extractNewsData(rawCompiledHTML);

      // THE UPSERT COMMAND: Find today's date + category. If it exists, overwrite it. If not, create it.
      await NewsRecord.findOneAndUpdate(
        { date: today, category: categoryName },  // Search criteria
        { data: structuredNewsData },             // Data to update
        { upsert: true, new: true }               // Options (upsert = insert if not found)
      );

      console.log(`✅ Saved ${categoryName} data to MongoDB!`);
    }

    res.json({ message: `Success! Database synchronized for ${today}.` });

  } catch (error) {
    console.error('Database Sync Error:', error);
    res.status(500).json({ error: 'Failed to sync database' });
  }
});


// ENDPOINT 2: THE FRONTEND API (Instant responses reading from the DB)
app.get('/api/news', async (req, res) => {
  try {
    const requestedCategory = req.query.category || 'general';
    const today = new Date().toLocaleDateString('en-CA');

    // Instantly query the database instead of running the scraper
    const newsItem = await NewsRecord.findOne({ date: today, category: requestedCategory });

    if (newsItem) {
      // Send the saved data directly to React
      return res.json(newsItem.data);
    } else {
      // If the DB is empty for today, tell the user to run the sync
      return res.status(404).json({ 
        error: `No data found for '${requestedCategory}' today. Please hit /api/sync-database first to populate the database.` 
      });
    }

  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Error fetching news from database' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});