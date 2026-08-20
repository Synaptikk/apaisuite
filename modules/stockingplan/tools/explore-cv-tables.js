// Playwright script to explore CaseVisibility table structure
// Run with: node explore-cv-tables.js

import { chromium } from 'playwright';

const CV_URL = 'https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html';
const STORE_NBR = '1458';
const BIZ_DATE = '2026-07-20'; // Adjust as needed

(async () => {
  console.log('🐶 Launching browser to explore CaseVisibility tables...\n');
  
  const browser = await chromium.launch({ 
    headless: false,
  });
  
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    proxy: {
      server: 'http://sysproxy.wal-mart.com:8080'
    }
  });
  
  const page = await context.newPage();
  
  console.log('🌐 Navigating to CaseVisibility...');
  await page.goto(CV_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for auth
  console.log('🔐 Waiting for authentication...');
  await page.waitForURL(/radapps3\.wal-mart\.com\/Protected\/CaseVisibility/, { timeout: 120000 });
  console.log('✅ Authenticated!\n');
  
  // Wait for page load
  await page.waitForSelector('#inpStoreNbr', { timeout: 30000 });
  console.log('✅ Page loaded!\n');
  
  // Fill search
  console.log(`🏪 Searching for Store ${STORE_NBR}, Date ${BIZ_DATE}...`);
  await page.fill('#inpStoreNbr', STORE_NBR);
  
  const dateInput = await page.$('#inpDate');
  if (dateInput) {
    await page.fill('#inpDate', BIZ_DATE);
  }
  
  // Wait for main_search
  await page.waitForFunction(() => typeof window.main_search === 'function', { timeout: 15000 });
  
  // Execute search
  await page.evaluate(() => window.main_search());
  console.log('🔍 Search initiated...\n');
  
  // Wait for spinner to hide
  await page.waitForFunction(() => {
    const spinner = document.querySelector('#divImgProcessing');
    return !spinner || window.getComputedStyle(spinner).display === 'none';
  }, { timeout: 30000 });
  
  console.log('⏳ Waiting for data to load...\n');
  await page.waitForTimeout(3000);
  
  // ====================================================================
  // EXPLORE ALL TABLES ON THE PAGE
  // ====================================================================
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 SCANNING ALL TABLES ON PAGE');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const tableData = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    
    tables.forEach((table, idx) => {
      const tableId = table.id || `(no id)`;
      const tableClass = table.className || `(no class)`;
      
      // Get headers
      const headers = [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
        .map(h => h.textContent.trim())
        .filter(Boolean);
      
      // Get first 5 rows
      const rows = [];
      const dataRows = table.querySelectorAll('tbody tr, tr');
      for (let i = 0; i < Math.min(5, dataRows.length); i++) {
        const cells = [...dataRows[i].querySelectorAll('td, th')]
          .map(c => c.textContent.trim());
        if (cells.length > 0) rows.push(cells);
      }
      
      results.push({
        index: idx,
        id: tableId,
        class: tableClass,
        headers,
        sampleRows: rows,
        totalRows: dataRows.length
      });
    });
    
    return results;
  });
  
  tableData.forEach((table, idx) => {
    console.log(`\n📋 TABLE ${idx + 1}:`);
    console.log(`   ID: ${table.id}`);
    console.log(`   Class: ${table.class}`);
    console.log(`   Total Rows: ${table.totalRows}`);
    
    if (table.headers.length > 0) {
      console.log(`   Headers: ${table.headers.join(' | ')}`);
    }
    
    if (table.sampleRows.length > 0) {
      console.log(`   Sample Data:`);
      table.sampleRows.forEach((row, rowIdx) => {
        console.log(`     Row ${rowIdx + 1}: ${row.join(' | ')}`);
      });
    }
    console.log('   ---');
  });
  
  // ====================================================================
  // LOOK FOR SPECIFIC NUMBERS
  // ====================================================================
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🔍 SEARCHING FOR KEY NUMBERS');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const searchNumbers = [335, 140, 195, 1680, 3883, 7760, 9267];
  
  for (const num of searchNumbers) {
    console.log(`\n🎯 Looking for "${num}" or "${num.toLocaleString()}"...`);
    
    const matches = await page.evaluate((searchNum) => {
      const numStr = String(searchNum);
      const numLocale = searchNum.toLocaleString();
      const results = [];
      
      // Search all text content
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      
      const seen = new Set();
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if ((text === numStr || text === numLocale) && !seen.has(text)) {
          seen.add(text);
          
          let parent = node.parentElement;
          let context = '';
          
          // Find table cell or parent context
          while (parent && parent !== document.body) {
            if (parent.tagName === 'TD' || parent.tagName === 'TH') {
              const row = parent.closest('tr');
              if (row) {
                context = [...row.querySelectorAll('td, th')]
                  .map(c => c.textContent.trim())
                  .join(' | ');
              }
              break;
            }
            parent = parent.parentElement;
          }
          
          results.push({
            value: text,
            context: context || text,
            tagName: node.parentElement?.tagName,
            className: node.parentElement?.className || ''
          });
        }
      }
      
      return results;
    }, num);
    
    if (matches.length > 0) {
      matches.forEach(match => {
        console.log(`   ✓ Found in <${match.tagName}${match.className ? '.' + match.className : ''}>`);
        console.log(`     Context: ${match.context.substring(0, 150)}${match.context.length > 150 ? '...' : ''}`);
      });
    } else {
      console.log(`   ✗ Not found`);
    }
  }
  
  // ====================================================================
  // CHECK FOR POPUPS/MODALS
  // ====================================================================
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🪟 CHECKING FOR HIDDEN POPUPS/MODALS');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const hiddenElements = await page.evaluate(() => {
    const divs = document.querySelectorAll('div[id], div[class*="modal"], div[class*="popup"], div[style*="display"]');
    const results = [];
    
    divs.forEach(div => {
      const id = div.id;
      const className = div.className;
      const style = div.getAttribute('style') || '';
      const display = window.getComputedStyle(div).display;
      
      if ((id || className) && display === 'none') {
        const tables = div.querySelectorAll('table');
        if (tables.length > 0) {
          results.push({
            id,
            className,
            display,
            tableCount: tables.length,
            hasContent: div.textContent.trim().length > 0
          });
        }
      }
    });
    
    return results;
  });
  
  if (hiddenElements.length > 0) {
    console.log('Found hidden containers with tables:');
    hiddenElements.forEach(el => {
      console.log(`   - ID: ${el.id || '(none)'}, Class: ${el.className || '(none)'}`);
      console.log(`     Tables: ${el.tableCount}, Has content: ${el.hasContent}`);
    });
  } else {
    console.log('No hidden tables found.');
  }
  
  // ====================================================================
  // SUMMARY
  // ====================================================================
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📝 SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`Total tables found: ${tableData.length}`);
  console.log(`\nKey numbers to locate:`);
  console.log(`  - 335 breakpack cases (140 + 195)`);
  console.log(`  - 3,883 inner packs`);
  console.log(`  - 7,760 F&C cases`);
  console.log(`  - 9,267 total cases`);
  
  console.log('\n✅ Exploration complete!');
  console.log('📸 Browser will stay open for manual inspection.');
  console.log('Press Ctrl+C when done.\n');
  
  // Keep browser open for manual inspection
  await page.waitForTimeout(600000); // 10 minutes
  
  await browser.close();
})();
