const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000; 

// 1. Fetch and clean the HTML for a single URL
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

    // Fix <noscript> images
    $('noscript').each((i, el) => {
      const noscriptContent = $(el).text();
      if (noscriptContent && noscriptContent.includes('<img')) {
        $(el).replaceWith(noscriptContent); 
      }
    });

    // Fix lazy-loaded images
    $('img').each((i, el) => {
      const realImage = $(el).attr('data-src') || $(el).attr('data-original') || $(el).attr('data-lazy-src');
      if (realImage) {
        $(el).attr('src', realImage); 
      }
    });

    // Strip heavy elements
    $('script, style, noscript, iframe, svg, header, footer, nav, aside').remove();
    
    $('*').each((i, el) => {
      const keep = ['href', 'src', 'alt', 'title', 'data-src', 'data-srcset', 'srcset'];
      const attributes = el.attribs;
      if (attributes) {
        Object.keys(attributes).forEach(attr => {
          if (!keep.includes(attr)) {
            $(el).removeAttr(attr);
          }
        });
      }
    });

    return `\n\n<div class="news-source">\n<h2>Source: ${url}</h2>\n${$.html()}\n</div>\n\n`;
    
  } catch (error) {
    console.error(`❌ Error fetching ${url}:`, error.message);
    return `<div class="news-source"><h2>Source: ${url}</h2><p>Failed to load.</p></div>`; 
  }
}

// 2. YOUR TRANSLATED NEWS FILTER SCRIPT
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

          // --- HEADLINE ---
          let headline = $link.find('h1, h2, h3, h4, h5, h6').first().text().trim() || $link.text().trim();
          
          if (!headline || headline.length < 15) {
              const $parent = $link.parent();
              if ($parent.length && $parent.find('a').length <= 8) {
                  headline = $parent.text().trim();
              } else {
                  const $grandParent = $parent.parent();
                  if ($grandParent.length && $grandParent.find('a').length <= 8) {
                      headline = $grandParent.text().trim();
                  }
              }
          }

          headline = headline.replace(/\n/g, ' - ').replace(/\s+/g, ' ').trim();
          if (!headline || headline.length < 20 || headline.length > 250 || headline.split(' ').length < 3) return; 

          const lowerHeadline = headline.toLowerCase();
          if (junkDictionary.some(junkWord => lowerHeadline.includes(junkWord))) return;

          // --- IMAGE HUNTER ---
          let bestImage = null;

          const checkAndClaimImage = (imgElement) => {
              if (!imgElement) return false;
              const $img = $(imgElement);
              let rawSrc = $img.attr('data-src') || $img.attr('src');
              
              if (!rawSrc && $img.attr('srcset')) {
                  rawSrc = $img.attr('srcset').split(',')[0].trim().split(' ')[0];
              }
              if (!rawSrc && $img.attr('data-srcset')) {
                  rawSrc = $img.attr('data-srcset').split(',')[0].trim().split(' ')[0];
              }

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
                  const uniqueHrefsInParent = new Set(
                      $currentParent.find('a').toArray()
                      .filter(a => $(a).text().trim().length > 10) 
                      .map(a => $(a).attr('href')?.split('?')[0]) 
                  );

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

          // --- DESCRIPTION HUNTER ---
          let bestDescription = null;
          let $descParent = $link.parent();
          let descLevels = 0;

          while ($descParent.length && descLevels < 5) {
              const uniqueHrefsInParent = new Set(
                  $descParent.find('a').toArray()
                  .filter(a => $(a).text().trim().length > 10) 
                  .map(a => $(a).attr('href')?.split('?')[0]) 
              );
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

          if (bestDescription && bestDescription.length > 150) {
              bestDescription = bestDescription.substring(0, 147).trim() + "...";
          }

          // --- FINALIZE & STORE ---
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

  console.log(`📰 EXTRACTION COMPLETE! Found ${totalFound} total articles.`);
  return allData; // Returns a pure JS object now
}

// 3. Compile everything simultaneously
async function compileAllNews() {
  const urls = [
    'https://www.nytimes.com/',
    'https://edition.cnn.com/',
    'https://timesofindia.indiatimes.com/',
    'https://www.theguardian.com/international',
    'https://www.aljazeera.com/',
    'https://www.bbc.com/news',
    'https://www.nbcnews.com/',
  ];

  const promises = urls.map(url => getCleanedHTML(url));
  const htmlSnippets = await Promise.all(promises);

  let combinedHTML = '<!DOCTYPE html>\n<html>\n<head>\n<title>All News Compilation</title>\n<meta charset="utf-8">\n</head>\n<body>\n';
  combinedHTML += htmlSnippets.join('\n');
  combinedHTML += '\n</body>\n</html>';

  return combinedHTML;
}

// 4. The JSON API Endpoint
app.get('/api/news', async (req, res) => {
  try {
    const rawCompiledHTML = await compileAllNews();
    
    // Pass HTML into your logic to extract the JSON object
    const structuredNewsData = extractNewsData(rawCompiledHTML);

    // Send the JSON object directly to the browser or frontend app
    res.json(structuredNewsData);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Error compiling news' });
  }
});

// 5. Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});