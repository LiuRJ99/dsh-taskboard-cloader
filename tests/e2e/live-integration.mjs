import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const BROWSER_PATH = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const TARGET_URL = 'http://127.0.0.1:3080'

async function runLiveIntegrationTest() {
  console.log('--- Starting Live Integration Test against', TARGET_URL, '---')
  const browser = await puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    const page = await browser.newPage()
    const consoleLogs = []
    page.on('console', msg => {
      const text = msg.text()
      consoleLogs.push(`[${msg.type()}] ${text}`)
    })
    page.on('pageerror', err => {
      consoleLogs.push(`[PAGEERROR] ${err.message}`)
    })

    console.log('1. Navigating to DSH Web GUI...')
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Wait for the app shell to mount
    await page.waitForSelector('#root', { timeout: 15000 })
    console.log('   App shell mounted.')

    // Wait 2s for all plugins and Cordis fibers to activate
    await new Promise(r => setTimeout(r, 2000))

    // Check if Better Sidebar host is mounted
    const hasBetterSidebar = await page.evaluate(() => {
      const el = document.querySelector('[data-dsh-better-sidebar]')
      return el !== null
    })
    console.log('2. Better Sidebar DOM host present:', hasBetterSidebar)

    // Check registered tabs in Better Sidebar
    const tabsInfo = await page.evaluate(() => {
      // Find Cordis context or Better Sidebar service if exposed or check DOM
      const panel = document.querySelector('[data-dsh-better-sidebar]')
      const toggleCluster = document.querySelector('[data-dsh-toggle-cluster]')
      return {
        hasPanel: panel !== null,
        hasToggleCluster: toggleCluster !== null,
      }
    })
    console.log('   Sidebar controls:', tabsInfo)

    // Click toggle button to open sidebar if closed
    const openSidebarResult = await page.evaluate(() => {
      const toggleBtn = document.querySelector('[data-dsh-toggle-cluster] button')
      if (toggleBtn) {
        toggleBtn.click()
        return 'clicked toggle button'
      }
      return 'toggle button not found'
    })
    console.log('3. Open sidebar result:', openSidebarResult)
    await new Promise(r => setTimeout(r, 1000))

    // Inspect TabBar and New Tab options
    const tabState = await page.evaluate(async () => {
      // Look for the '+' button on TabBar
      const newTabBtns = Array.from(document.querySelectorAll('button')).filter(b => {
        const aria = b.getAttribute('aria-label') || ''
        const title = b.getAttribute('title') || ''
        return aria.includes('新') || aria.includes('Tab') || title.includes('新') || title.includes('Tab') || b.textContent.includes('+')
      })
      return {
        newTabBtnCount: newTabBtns.length,
        buttons: newTabBtns.map(b => ({
          aria: b.getAttribute('aria-label'),
          title: b.getAttribute('title'),
          text: b.textContent.trim(),
        }))
      }
    })
    console.log('4. TabBar "+" button search:', tabState)

    // Click the New Tab '+' button to open the dropdown menu
    const menuResult = await page.evaluate(() => {
      const plusBtn = Array.from(document.querySelectorAll('button')).find(b => {
        const aria = b.getAttribute('aria-label') || ''
        const title = b.getAttribute('title') || ''
        return (aria.includes('新') && (aria.includes('标签') || aria.includes('Tab'))) ||
               (title.includes('新') && (title.includes('标签') || title.includes('Tab'))) ||
               b.textContent.trim() === '+'
      })
      if (plusBtn) {
        plusBtn.click()
        return { ok: true, text: plusBtn.getAttribute('aria-label') || plusBtn.getAttribute('title') }
      }
      return { ok: false }
    })
    console.log('5. Clicking "+" menu button:', menuResult)
    await new Promise(r => setTimeout(r, 800))

    // List items inside the open menu
    const menuItems = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('button, div[role="menuitem"], [class*="menuItem"], [class*="newTabOption"]'))
      return items.map(el => ({
        text: el.textContent.trim(),
        className: el.className,
        role: el.getAttribute('role'),
      })).filter(i => i.text.length > 0 && i.text.length < 50)
    })
    console.log('6. Open menu items:', menuItems.map(i => i.text))

    // Check if "任务看板" is in menu items and click it
    const taskboardMenuItem = await page.evaluate(() => {
      const allButtons = Array.from(document.querySelectorAll('button, div[role="menuitem"], [class*="newTabOption"]'))
      const tbBtn = allButtons.find(b => b.textContent.includes('任务看板'))
      if (tbBtn) {
        tbBtn.click()
        return { found: true, text: tbBtn.textContent.trim() }
      }
      return { found: false }
    })
    console.log('7. Clicking "任务看板" Tab option:', taskboardMenuItem)
    await new Promise(r => setTimeout(r, 1500))

    // Verify if TaskBoard is mounted in Better Sidebar
    const taskboardDomState = await page.evaluate(() => {
      const tabContainer = document.querySelector('.dsh-atb-sidebar-tab, [data-dsh-atb-sidebar-tab]')
      const boardRoot = document.querySelector('[data-dsh-atb-board]')
      const columns = Array.from(document.querySelectorAll('.dsh-atb-col, [class*="dsh-atb-column"], .dsh-atb-col-head'))
      const toolbar = document.querySelector('.dsh-atb-tb')
      return {
        tabContainerFound: tabContainer !== null,
        boardRootFound: boardRoot !== null,
        boardRootVisible: boardRoot ? boardRoot.getAttribute('data-dsh-atb-visible') : null,
        columnCount: columns.length,
        columnHeaders: columns.map(c => c.textContent.trim()).filter(t => t.length > 0),
        toolbarFound: toolbar !== null,
      }
    })
    console.log('8. TaskBoard Tab DOM state:', taskboardDomState)

    // Check console errors
    const errors = consoleLogs.filter(l => l.includes('error') || l.includes('ERROR') || l.includes('FAIL'))
    console.log('9. Filtered Console Errors count:', errors.length)
    if (errors.length > 0) {
      console.log('   Recent errors:', errors.slice(-5))
    }

    // Capture screenshot
    const screenshotPath = '/tmp/dsh-taskboard-live-integration.png'
    await page.screenshot({ path: screenshotPath, fullPage: false })
    console.log('10. Captured live screenshot at:', screenshotPath)

    return {
      success: taskboardMenuItem.found && taskboardDomState.boardRootFound,
      hasBetterSidebar,
      taskboardMenuItem,
      taskboardDomState,
      consoleLogsSample: consoleLogs.slice(-15),
      screenshotPath,
    }
  } finally {
    await browser.close()
  }
}

runLiveIntegrationTest()
  .then(res => {
    console.log('\n=== TEST SUMMARY ===')
    console.log(JSON.stringify(res, null, 2))
    process.exit(res.success ? 0 : 1)
  })
  .catch(err => {
    console.error('Fatal test runner failure:', err)
    process.exit(2)
  })
