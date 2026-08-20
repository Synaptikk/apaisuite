// Test script to inspect CaseVisibility API response fields
// Run with: node test-cv-fields.js

import { chromium } from 'playwright';

const CV_URL = 'https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html';
const STORE_NBR = '2152'; // Default test store
const BIZ_DATE = new Date().toISOString().split('T')[0]; // Today

(async () => {
  console.log('🐶 Launching browser to inspect CaseVisibility fields...\n');
  
  const browser = await chromium.launch({ 
    headless: false,
    args: [
      '--proxy-server=http://sysproxy.wal-mart.com:8080'
    ]
  });
  
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  
  const page = await context.newPage();
  
  // Intercept the Main.ashx API call
  let apiResponse = null;
  page.on('response', async (response) => {
    if (response.url().includes('Main.ashx') && response.url().includes('func=init')) {
      console.log('📡 Intercepted Main.ashx?func=init response!\n');
      try {
        apiResponse = await response.json();
      } catch (e) {
        console.error('❌ Failed to parse JSON:', e.message);
      }
    }
  });
  
  console.log('🌐 Navigating to CaseVisibility...');
  await page.goto(CV_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for potential SSO redirect and sign-in
  console.log('🔐 Waiting for authentication (you may need to sign in)...');
  await page.waitForURL(/radapps3\.wal-mart\.com\/Protected\/CaseVisibility/, { timeout: 120000 });
  console.log('✅ Authenticated!\n');
  
  // Wait for page to fully load
  await page.waitForSelector('#inpStoreNbr', { timeout: 30000 });
  console.log('✅ CaseVisibility page loaded!\n');
  
  // Fill in store number and date
  console.log(`🏪 Searching for Store ${STORE_NBR}, Date ${BIZ_DATE}...`);
  await page.fill('#inpStoreNbr', STORE_NBR);
  
  const dateInput = await page.$('#inpDate');
  if (dateInput) {
    await page.fill('#inpDate', BIZ_DATE);
  }
  
  // Wait for main_search function to be available
  await page.waitForFunction(() => typeof window.main_search === 'function', { timeout: 15000 });
  
  // Execute the search
  await page.evaluate(() => window.main_search());
  console.log('🔍 Search initiated...\n');
  
  // Wait for loading spinner to disappear
  await page.waitForFunction(() => {
    const spinner = document.querySelector('#divImgProcessing');
    return !spinner || window.getComputedStyle(spinner).display === 'none';
  }, { timeout: 30000 });
  
  console.log('⏳ Waiting for API response...\n');
  
  // Give it a few seconds to ensure the API call completes
  await page.waitForTimeout(5000);
  
  if (!apiResponse) {
    console.log('⚠️  No API response intercepted. Trying manual fetch...\n');
    
    // Manually call the API
    apiResponse = await page.evaluate(async ([storeNbr, bizDate]) => {
      const params = new URLSearchParams({
        func: 'init',
        storeNbr: storeNbr,
        businessDate: bizDate.replace(/-/g, '/'),
      });
      const resp = await fetch(`/Protected/CaseVisibility/ashx/Main.ashx?${params.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      return resp.json();
    }, [STORE_NBR, BIZ_DATE]);
  }
  
  if (apiResponse) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 CASEVISIBILITY API RESPONSE STRUCTURE');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const schedule = apiResponse.schedule || {};
    const associates = schedule.scheduled_associates || [];
    
    console.log(`Total associates found: ${associates.length}\n`);
    
    if (associates.length > 0) {
      console.log('📋 FIELDS AVAILABLE IN EACH ASSOCIATE ROW:
      console.log('-----------------------------------------------------------');
      const fields = Object.keys(associates[0]);
      fields.forEach(field => {
        console.log(`  - ${field}`);
      });
      
      console.log('\n📝 SAMPLE ASSOCIATE DATA (first 3 rows):');
      console.log('-----------------------------------------------------------');
      
      for (let i = 0; i < Math.min(3, associates.length); i++) {
        const assoc = associates[i];
        console.log(`\n${i + 1}. ${assoc.preferred_name || assoc.fname || 'Unknown'}`);
        
        // Show all fields
        Object.entries(assoc).forEach(([key, value]) => {
          console.log(`   ${key}: ${JSON.stringify(value)}`);
        });
      }
      
      console.log('\n🎯 JOB-RELATED FIELDS DETECTED:');
      console.log('-----------------------------------------------------------');
      const jobFields = fields.filter(f => 
        /job|position|role|title|group|code/i.test(f)
      );
      
      if (jobFields.length > 0) {
        jobFields.forEach(field => {
          const uniqueValues = [...new Set(associates.map(a => a[field]))];
          console.log(`\n  ${field}:`);
          uniqueValues.forEach(val => {
            const count = associates.filter(a => a[field] === val).length;
            console.log(`    - "${val}" (${count} associates)`);
          });
        });
      } else {
        console.log('  ⚠️  No obvious job-related fields found!');
        console.log('  We may need to use shift times or other logic.');
      }
      
      console.log('\n⏰ SHIFT TIME PATTERNS:');
      console.log('-----------------------------------------------------------');
      const shiftPatterns = {};
      associates.forEach(a => {
        if (a.shift_start_ts) {
          const startTime = new Date(a.shift_start_ts);
          const hour = startTime.getHours();
          const hourKey = `${hour}:00`;
          if (!shiftPatterns[hourKey]) shiftPatterns[hourKey] = [];
          shiftPatterns[hourKey].push(a.preferred_name || a.fname || 'Unknown');
        }
      });
      
      Object.entries(shiftPatterns).sort().forEach(([hour, names]) => {
        console.log(`  ${hour} - ${names.length} associates: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '...' : ''}`);
      });
      
    } else {
      console.log('❌ No associates found in response!');
    }
    
    console.log('\n═══════════════════════════════════════════════════════════\n');
    
    // Save full response to file for inspection
    const fs = await import('fs');
    fs.writeFileSync('cv-response.json', JSON.stringify(apiResponse, null, 2));
    console.log('💾 Full response saved to cv-response.json\n');
    
  } else {
    console.log('❌ Failed to capture API response!');
  }
  
  console.log('✅ Test complete! Press Ctrl+C or close browser to exit.\n');
  
  // Keep browser open for manual inspection
  await page.waitForTimeout(300000); // 5 minutes
  
  await browser.close();
})();
