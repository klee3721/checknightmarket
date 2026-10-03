const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { chromium } = require('playwright-core');
const { ensureDir, findBrowserExecutable, safeFilename } = require('./utils');

const execFileAsync = promisify(execFile);

class SetupRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupRequiredError';
  }
}

class WorkflowError extends Error {
  constructor(message, code = 'WORKFLOW_ERROR') {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Không cấp được cổng điều khiển Chrome nội bộ.'));
        else resolve(port);
      });
    });
  });
}

async function firstVisible(page, selectors, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const matches = page.locator(selector);
        const count = Math.min(await matches.count(), 50);
        for (let index = 0; index < count; index += 1) {
          const locator = matches.nth(index);
          if (await locator.isVisible()) return locator;
        }
      } catch {
        // A selector may be temporarily invalid while the SPA is replacing its DOM.
      }
    }
    await sleep(250);
  }
  return null;
}

async function firstSelectorWithCount(page, selectors, minimum = 1, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector);
        const count = await locator.count();
        if (count >= minimum) return { locator, count, selector };
      } catch {
        // Keep trying alternative selectors.
      }
    }
    await sleep(300);
  }
  return null;
}

async function clickFirst(page, selectors, timeoutMs) {
  const locator = await firstVisible(page, selectors, timeoutMs);
  if (!locator) return false;
  await locator.click({ timeout: timeoutMs });
  return true;
}

function isMenzuLogin(url) {
  return /menzu\.lol\/login(?:[/?#]|$)/i.test(url);
}

function isTokenUrl(url) {
  return /^http:\/\/localhost\/redirect#/i.test(url) && /(?:^|[&#])access_token=/i.test(url);
}

function isRiotAuthUrl(url) {
  return /^https:\/\/(?:auth|authenticate)\.riotgames\.com(?:[/:?#]|$)/i.test(url);
}

async function regularChromeTabUrls() {
  if (process.platform !== 'darwin') {
    throw new WorkflowError('Chế độ đăng nhập Riot bằng Chrome thường hiện chỉ hỗ trợ macOS.', 'MANUAL_LOGIN_UNSUPPORTED');
  }
  const script = [
    'tell application "Google Chrome"',
    'set outputText to ""',
    'repeat with theWindow in every window',
    'repeat with theTab in every tab of theWindow',
    'set outputText to outputText & (URL of theTab) & (ASCII character 10)',
    'end repeat',
    'end repeat',
    'return outputText',
    'end tell'
  ];
  const { stdout } = await execFileAsync('/usr/bin/osascript', script.flatMap((line) => ['-e', line]), {
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  return stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
}

class BrowserWorker {
  constructor({ id, root, config, events, resultStore, previewEnabled, closeRiotAfterToken }) {
    this.id = id;
    this.root = root;
    this.config = config;
    this.events = events;
    this.resultStore = resultStore;
    this.previewEnabled = previewEnabled;
    this.profileDir = ensureDir(path.join(root, 'profiles', `worker-${id}`));
    this.runtimeDir = ensureDir(path.join(root, 'runtime', `worker-${id}`));
    this.riotProfileDir = path.join(this.runtimeDir, 'riot-profile');
    this.previewPath = path.join(this.runtimeDir, 'preview.jpg');
    this.context = null;
    this.activePage = null;
    this.menzuPage = null;
    this.riotPage = null;
    this.headless = null;
    this.status = 'closed';
    this.currentAccount = null;
    this.stopRequested = false;
    this.loopPromise = null;
    this.previewTimer = null;
    this.captureBusy = false;
    this.sensitive = false;
    this.manualBrowserProcess = null;
    this.manualLoginConfirmed = false;
    this.manualLoginResolve = null;
    this.manualLoginReject = null;
    this.manualBrowserExited = false;
    this.manualCdpBrowser = null;
    this.manualDebugPort = null;
    this.manualSessionClean = false;
    this.closeRiotAfterToken = Boolean(closeRiotAfterToken);
    this.riotLoginUrl = null;
    this.closing = false;
  }

  log(level, message, accountId = this.currentAccount) {
    this.events.log({ workerId: this.id, level, message, accountId: accountId || null });
  }

  setStatus(status) {
    this.status = status;
    this.events.changed();
  }

  publicState() {
    return {
      id: this.id,
      status: this.status,
      currentAccount: this.currentAccount,
      launched: Boolean(this.context),
      headless: this.headless,
      riotBrowserOpen: Boolean(this.manualBrowserProcess) && !this.manualBrowserExited,
      hasPreview: Boolean(this.context) && fs.existsSync(this.previewPath)
    };
  }

  async setCloseRiotAfterToken(value) {
    const next = Boolean(value);
    if (next && !this.closeRiotAfterToken && this.manualBrowserProcess) {
      await this.cleanupManualRiotBrowser();
    }
    this.closeRiotAfterToken = next;
  }

  async launch(headless, openSetupPage = false) {
    if (this.context && this.headless === headless) {
      if (openSetupPage) await this.openMenzuSetup();
      return;
    }
    if (this.context) await this.disposeAutomationContext();

    this.setStatus('launching');
    this.log('info', `Đang mở profile ${headless ? 'chạy ngầm' : 'có giao diện'}.`);
    const executablePath = findBrowserExecutable();
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      executablePath,
      headless,
      viewport: headless ? { width: 1440, height: 1000 } : null,
      args: headless ? [] : ['--start-maximized'],
      locale: 'vi-VN',
      acceptDownloads: false
    });
    this.headless = headless;
    this.context.setDefaultTimeout(this.config.timeouts.actionMs);
    this.context.setDefaultNavigationTimeout(this.config.timeouts.navigationMs);
    this.context.on('page', (page) => this.attachPage(page));
    for (const page of this.context.pages()) this.attachPage(page);
    this.startPreview();
    this.setStatus('idle');
    if (openSetupPage) await this.openMenzuSetup();
  }

  attachPage(page) {
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    page.on('close', () => {
      if (this.activePage === page) this.activePage = null;
    });
    page.on('crash', () => this.log('error', 'Một tab trình duyệt đã bị crash.'));
  }

  startPreview() {
    clearInterval(this.previewTimer);
    this.previewTimer = setInterval(() => {
      this.capturePreview().catch(() => {});
    }, 1500);
    this.previewTimer.unref?.();
  }

  async capturePreview(force = false) {
    if (this.sensitive || (!this.previewEnabled() && !force) || this.captureBusy || !this.context) return;
    const page = this.activePage || this.context.pages().find((candidate) => !candidate.isClosed());
    if (!page || page.isClosed()) return;
    this.captureBusy = true;
    try {
      await page.screenshot({ path: this.previewPath, type: 'jpeg', quality: 65, timeout: 5000 });
    } finally {
      this.captureBusy = false;
    }
  }

  async openMenzuSetup() {
    if (!this.context) await this.launch(false, false);
    let page = this.menzuPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.menzuPage = page;
    this.activePage = page;
    await page.bringToFront().catch(() => {});
    await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    this.log('info', isMenzuLogin(page.url())
      ? 'Hãy đăng nhập Menzu trong cửa sổ vừa mở; profile sẽ ghi nhớ phiên.'
      : 'Phiên Menzu đang hoạt động.');
    this.setStatus(isMenzuLogin(page.url()) ? 'needs_setup' : 'idle');
    await this.capturePreview(true);
  }

  async verifyMenzuSession() {
    if (!this.context) throw new SetupRequiredError('Profile chưa được mở.');
    let page = this.menzuPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.menzuPage = page;
    this.activePage = page;
    await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    if (isMenzuLogin(page.url())) {
      this.setStatus('needs_setup');
      throw new SetupRequiredError('Chưa đăng nhập Menzu. Bấm “Mở / đăng nhập Menzu” cho luồng này.');
    }
    this.setStatus('idle');
    this.log('info', 'Đã xác nhận phiên đăng nhập Menzu.');
    return true;
  }

  async inspectMenzuArchive() {
    if (!this.context) throw new SetupRequiredError('Profile chưa được mở.');
    let page = this.menzuPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.menzuPage = page;
    this.activePage = page;
    if (!/menzu\.lol\/checkskin/i.test(page.url())) {
      await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    }
    if (isMenzuLogin(page.url())) throw new SetupRequiredError('Phiên Menzu đã hết hạn.');
    await this.scrollToArchive(page);
    await sleep(500);
    await this.capturePreview(true);
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],p,div')]
        .find((element) => /Kho lưu trữ/i.test(element.textContent || '') && clean(element.textContent).length < 120);
      const root = heading?.closest('section,main,[class*="archive" i],[class*="storage" i]') || heading?.parentElement?.parentElement || document.body;
      const candidates = [...root.querySelectorAll('[data-account-id],[class*="account" i],[class*="card" i],article,li')]
        .filter((element) => {
          const text = clean(element.innerText);
          const rect = element.getBoundingClientRect();
          return text && rect.width > 100 && rect.height > 40;
        })
        .slice(0, 50)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: clean(element.className),
          dataAccountId: clean(element.getAttribute('data-account-id')),
          text: clean(element.innerText)
        }));
      return { heading: clean(heading?.textContent), candidates };
    });
  }

  async inspectMenzuNightMarket() {
    if (!this.context) throw new SetupRequiredError('Profile chưa được mở.');
    const page = this.menzuPage;
    if (!page || page.isClosed()) throw new SetupRequiredError('Tab Menzu chưa được mở.');
    const heading = page.getByText(/Chợ đêm.*Night Market|Night Market/i).last();
    if (await heading.count().catch(() => 0)) {
      await heading.scrollIntoViewIfNeeded().catch(() => {});
    }
    await sleep(500);
    await this.capturePreview(true);
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],p,div')]
        .filter((element) => /Chợ đêm.*Night Market|Night Market/i.test(clean(element.textContent)) && clean(element.textContent).length < 120);
      const anchor = headings.at(-1);
      const anchorRect = anchor?.getBoundingClientRect();
      const candidates = [...document.querySelectorAll('button,[role="button"],article,li,[class]')]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          if (!anchorRect || rect.width < 120 || rect.height < 80) return false;
          if (rect.bottom < anchorRect.top - 100 || rect.top > anchorRect.top + 1200) return false;
          const style = getComputedStyle(element);
          return style.visibility !== 'hidden' && style.display !== 'none';
        })
        .slice(0, 100)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: clean(element.className),
            role: clean(element.getAttribute('role')),
            text: clean(element.innerText),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top)
          };
        });
      return { headings: headings.map((element) => clean(element.textContent)), candidates };
    });
  }

  async close() {
    this.stopRequested = true;
    this.closing = true;
    if (this.manualLoginReject) {
      this.manualLoginReject(new WorkflowError('Đã hủy đăng nhập Riot thủ công.', 'RIOT_MANUAL_LOGIN_CANCELLED'));
    }
    await this.cleanupManualRiotBrowser();
    await this.disposeAutomationContext();
    this.riotLoginUrl = null;
    this.closing = false;
    this.setStatus('closed');
    this.log('info', 'Đã đóng profile.');
  }

  async disposeAutomationContext() {
    clearInterval(this.previewTimer);
    this.previewTimer = null;
    const context = this.context;
    this.context = null;
    this.activePage = null;
    this.menzuPage = null;
    this.riotPage = null;
    if (context) await context.close().catch(() => {});
    this.headless = null;
  }

  requestStop() {
    this.stopRequested = true;
    if (this.status === 'running') this.setStatus('stopping');
  }

  resumeManualLogin() {
    const child = this.manualBrowserProcess;
    if (!child || this.manualBrowserExited || this.status !== 'manual_login' || !this.manualLoginResolve) {
      throw new Error('Luồng này không chờ xác nhận đăng nhập Riot.');
    }
    this.manualLoginConfirmed = true;
    this.log('info', 'Đã nhận xác nhận đăng nhập Riot; đang mở URL liên kết trong tab mới.');
    const resolve = this.manualLoginResolve;
    this.manualLoginResolve = null;
    this.manualLoginReject = null;
    resolve();
  }

  async run(queue, defaultHeadless) {
    if (this.loopPromise) return this.loopPromise;
    this.stopRequested = false;
    this.loopPromise = this.runLoop(queue, defaultHeadless).finally(() => {
      this.loopPromise = null;
      this.currentAccount = null;
      if (this.context && !['needs_setup', 'needs_attention'].includes(this.status)) this.setStatus('idle');
    });
    return this.loopPromise;
  }

  async runLoop(queue, defaultHeadless) {
    await this.launch(defaultHeadless, false);
    try {
      await this.verifyMenzuSession();
    } catch (error) {
      if (error instanceof SetupRequiredError) {
        this.log('error', error.message);
        return;
      }
      throw error;
    }

    while (!this.stopRequested) {
      const account = queue.claim(this.id);
      if (!account) break;
      this.currentAccount = account.id;
      this.setStatus('running');
      this.log('info', 'Bắt đầu xử lý tài khoản.');
      try {
        const image = await this.processAccount(account);
        const relativeImage = this.resultStore.append({
          id: account.id,
          image,
          status: 'success',
          workerId: this.id,
          message: 'Đã chụp Night Market'
        });
        queue.update(account, 'success', {
          image: relativeImage,
          message: 'Đã chụp Night Market'
        });
        this.log('success', `Hoàn tất, ảnh: ${relativeImage}`);
      } catch (error) {
        await this.saveErrorScreenshot(account.id).catch(() => {});
        if (error instanceof SetupRequiredError) {
          queue.release(account, error.message);
          this.log('error', error.message);
          this.setStatus('needs_setup');
          break;
        }
        const code = error.code ? `${error.code}: ` : '';
        const message = `${code}${String(error.message || error)}`.slice(0, 500);
        if (error instanceof WorkflowError && (
          error.code.startsWith('SELECTOR_')
          || error.code === 'MENZU_CHECK_TIMEOUT'
          || error.code === 'MENZU_DELETE_TIMEOUT'
        )) {
          queue.release(account, message);
          this.log('error', `${message} Luồng đã tạm dừng để tránh lỗi hàng loạt.`);
          this.setStatus('needs_attention');
          break;
        }
        queue.update(account, 'failed', { message });
        this.resultStore.append({
          id: account.id,
          status: 'failed',
          workerId: this.id,
          message
        });
        this.log('error', message);
      } finally {
        if (this.closeRiotAfterToken) {
          await this.cleanupManualRiotBrowser().catch((error) => {
            this.log('warn', `Không đóng sạch được Chrome Riot: ${error.message}`);
          });
        } else if (this.manualBrowserProcess && !this.manualSessionClean) {
          await this.resetReusableManualRiotBrowser().catch(async (error) => {
            this.log('warn', `Không dọn được phiên Riot để tái sử dụng Chrome: ${error.message}. Chrome Riot sẽ được mở mới ở lượt sau.`);
            await this.cleanupManualRiotBrowser().catch(() => {});
          });
        }
        await this.cleanupRiotSession().catch((error) => {
          this.log('warn', `Không dọn sạch được phiên Riot: ${error.message}`);
        });
        this.currentAccount = null;
        this.events.changed();
      }
    }
  }

  async processAccount(account) {
    await this.cleanupRiotSession();
    const recoveredImage = await this.recoverSingleArchivedAccount(account.id);
    if (recoveredImage) return recoveredImage;
    let tokenUrl;
    if (this.headless) {
      await this.loginRiot(account);
      tokenUrl = await this.obtainTokenFromMenzu();
    } else {
      tokenUrl = await this.obtainTokenWithRegularChrome();
      if (this.closeRiotAfterToken) {
        await this.cleanupManualRiotBrowser();
        this.log('info', 'B2: đã lấy token và đóng Chrome Riot; đang chuyển về tab Menzu.');
      } else {
        this.log('info', 'B2: đã lấy token; Chrome Riot được giữ lại để dùng cho lượt sau.');
      }
    }
    await this.submitToken(tokenUrl);
    const image = await this.openNightMarketAndCapture(account.id);
    await this.deleteMenzuAccount();
    if (this.headless) {
      await this.logoutRiot();
    } else if (this.closeRiotAfterToken) {
      this.log('info', 'B6: phiên Chrome Riot tạm đã được xóa sạch.');
    } else {
      await this.resetReusableManualRiotBrowser();
    }
    return image;
  }

  async recoverSingleArchivedAccount(accountId) {
    const page = this.menzuPage;
    if (!page || page.isClosed() || isMenzuLogin(page.url())) return null;
    await this.scrollToArchive(page);
    const cards = await this.findArchiveCards(page, 1000);
    if (cards?.count !== 1) return null;
    this.log('warn', 'Phát hiện đúng 1 card còn lại từ lần check trước; đang tiếp tục card đó và bỏ qua bước lấy token lại.');
    const image = await this.openNightMarketAndCapture(accountId);
    await this.deleteMenzuAccount();
    return image;
  }

  async loginRiot(account) {
    this.log('info', 'B1: đăng nhập Riot.');
    let page = this.riotPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.riotPage = page;
    this.activePage = page;
    await page.goto(this.config.urls.riotHome, { waitUntil: 'domcontentloaded' });
    await clickFirst(page, this.config.selectors.riot.cookieButtons || [], 2500).catch(() => false);

    const clicked = await clickFirst(page, this.config.selectors.riot.loginButtons, this.config.timeouts.actionMs);
    if (!clicked) {
      throw new WorkflowError('Không tìm thấy nút đăng nhập Riot. Hãy cập nhật selectors.riot.loginButtons.', 'SELECTOR_RIOT_LOGIN');
    }
    await sleep(1500);
    const authPage = this.context.pages().find((candidate) => isRiotAuthUrl(candidate.url())) || page;
    this.riotPage = authPage;
    this.activePage = authPage;
    await clickFirst(authPage, this.config.selectors.riot.cookieButtons || [], 2500).catch(() => false);

    const username = await firstVisible(authPage, this.config.selectors.riot.usernameInputs, this.config.timeouts.actionMs * 2);
    const password = await firstVisible(authPage, this.config.selectors.riot.passwordInputs, this.config.timeouts.actionMs);
    if (!username || !password) {
      throw new WorkflowError('Không tìm thấy ô ID/mật khẩu Riot. Có thể giao diện đăng nhập đã đổi.', 'SELECTOR_RIOT_CREDENTIALS');
    }
    await username.fill(account.id);
    this.sensitive = true;
    try {
      await password.fill(account.password);
      const submitted = await clickFirst(authPage, this.config.selectors.riot.submitButtons, this.config.timeouts.actionMs);
      if (!submitted) await password.press('Enter');
      await this.waitForRiotLogin(authPage);
    } finally {
      if (!authPage.isClosed() && isRiotAuthUrl(authPage.url())) {
        await password.fill('').catch(() => {});
      }
      this.sensitive = false;
    }
    this.log('info', 'Đăng nhập Riot thành công.');
  }

  async obtainTokenWithRegularChrome() {
    this.log('info', 'B1: chuẩn bị Chrome thường để đăng nhập Riot. Tab Menzu vẫn được giữ nguyên.');
    const authUrl = await this.getRiotLoginUrl();
    const executablePath = findBrowserExecutable();
    const baselineTokenUrls = new Set((await regularChromeTabUrls()).filter(isTokenUrl));
    let child = this.manualBrowserProcess;
    const canReuse = !this.closeRiotAfterToken && child && !this.manualBrowserExited && !child.killed;
    if (canReuse) {
      this.log('info', 'Đang dùng lại cửa sổ Chrome Riot đã được đăng xuất từ lượt trước.');
    } else {
      await this.cleanupManualRiotBrowser();
      fs.rmSync(this.riotProfileDir, { recursive: true, force: true });
      ensureDir(this.riotProfileDir);
      this.manualDebugPort = await reserveLocalPort();
      child = spawn(executablePath, [
        `--user-data-dir=${this.riotProfileDir}`,
        `--remote-debugging-port=${this.manualDebugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--new-window',
        this.config.urls.riotHome
      ], { stdio: 'ignore' });
      this.manualBrowserProcess = child;
      this.manualBrowserExited = false;
      child.once('exit', () => {
        this.manualBrowserExited = true;
        this.manualCdpBrowser = null;
      });
      this.log('info', 'Đã mở cửa sổ Chrome Riot mới.');
    }

    this.manualSessionClean = false;
    this.manualLoginConfirmed = false;
    this.setStatus('manual_login');
    this.log('warn', 'Chrome Riot đã mở. Hãy đăng nhập tài khoản đang chạy rồi bấm “Đã đăng nhập Riot · tiếp tục”; không đóng tab Menzu.');
    await new Promise((resolve, reject) => {
      const cleanupListeners = () => {
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onError = (error) => {
        cleanupListeners();
        reject(error);
      };
      const onExit = (code, signal) => {
        cleanupListeners();
        if (!this.manualLoginConfirmed) {
          reject(new WorkflowError(`Chrome Riot đã đóng trước khi xác nhận (${signal || code || 'exit'}).`, 'RIOT_MANUAL_BROWSER_EXIT'));
        }
      };
      this.manualLoginResolve = () => {
        cleanupListeners();
        resolve();
      };
      this.manualLoginReject = (error) => {
        cleanupListeners();
        reject(error);
      };
      child.once('error', onError);
      child.once('exit', onExit);
    });

    if (this.manualBrowserExited) {
      throw new WorkflowError('Chrome Riot đã đóng trước khi mở URL liên kết.', 'RIOT_MANUAL_BROWSER_EXIT');
    }
    this.setStatus(this.stopRequested ? 'stopping' : 'running');
    this.log('info', 'B2: đang mở tab Riot OAuth mới bằng link đã lấy từ Menzu.');
    const opener = spawn(executablePath, [
      `--user-data-dir=${this.riotProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--new-tab',
      authUrl
    ], { stdio: 'ignore' });
    opener.unref();

    const deadline = Date.now() + this.config.timeouts.tokenMs;
    while (Date.now() < deadline) {
      if (this.manualBrowserExited) {
        throw new WorkflowError('Chrome Riot đã đóng trước khi nhận được URL token.', 'RIOT_MANUAL_BROWSER_EXIT');
      }
      const tokenUrl = (await regularChromeTabUrls())
        .find((url) => isTokenUrl(url) && !baselineTokenUrls.has(url));
      if (tokenUrl) {
        this.log('info', 'Đã nhận URL token từ Chrome Riot (đã ẩn khỏi log).');
        return tokenUrl;
      }
      await sleep(300);
    }
    throw new WorkflowError('Không nhận được URL token từ Chrome Riot.', 'TOKEN_TIMEOUT');
  }

  async getRiotLoginUrl() {
    if (this.riotLoginUrl) {
      this.log('info', 'Đang dùng lại link Riot OAuth đã lưu trong RAM; không mở lại Menzu để lấy link.');
      return this.riotLoginUrl;
    }
    this.riotLoginUrl = await this.extractRiotLoginUrlFromMenzu();
    this.log('info', 'Đã lấy link Riot OAuth một lần và lưu trong RAM cho luồng này.');
    return this.riotLoginUrl;
  }

  async extractRiotLoginUrlFromMenzu() {
    const mainPage = this.menzuPage;
    if (!mainPage || mainPage.isClosed()) throw new SetupRequiredError('Tab Menzu chưa được mở.');
    if (isMenzuLogin(mainPage.url())) throw new SetupRequiredError('Phiên Menzu đã hết hạn.');

    const temporaryPage = await this.context.newPage();
    const pagesBefore = new Set(this.context.pages());
    try {
      await temporaryPage.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
      if (isMenzuLogin(temporaryPage.url())) throw new SetupRequiredError('Phiên Menzu đã hết hạn.');
      const button = await firstVisible(
        temporaryPage,
        this.config.selectors.menzu.riotLoginButtons,
        this.config.timeouts.actionMs * 2
      );
      if (!button) {
        throw new WorkflowError('Không tìm thấy nút “Đăng nhập Riot Games” trên Menzu.', 'SELECTOR_MENZU_RIOT');
      }
      const directUrl = await button.evaluate((element) => {
        const link = element.closest('a') || element.querySelector('a');
        return link?.href || null;
      }).catch(() => null);
      if (directUrl && isRiotAuthUrl(directUrl)) return directUrl;

      await button.click();
      const deadline = Date.now() + this.config.timeouts.actionMs * 2;
      while (Date.now() < deadline) {
        const candidate = this.context.pages().find((page) => isRiotAuthUrl(page.url()));
        if (candidate) return candidate.url();
        await sleep(100);
      }
      throw new WorkflowError('Không lấy được URL đăng nhập Riot từ Menzu.', 'SELECTOR_MENZU_RIOT_URL');
    } finally {
      for (const page of this.context.pages()) {
        if (page !== mainPage && (page === temporaryPage || !pagesBefore.has(page))) {
          await page.close().catch(() => {});
        }
      }
      this.menzuPage = mainPage;
      this.activePage = mainPage;
    }
  }

  async connectToManualRiotBrowser() {
    if (this.manualCdpBrowser?.isConnected()) return this.manualCdpBrowser;
    const port = this.manualDebugPort;
    if (!port) throw new WorkflowError('Chrome Riot không có cổng điều khiển nội bộ.', 'RIOT_REUSE_CONNECT');
    const deadline = Date.now() + 5000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        this.manualCdpBrowser = browser;
        browser.once('disconnected', () => {
          if (this.manualCdpBrowser === browser) this.manualCdpBrowser = null;
        });
        return browser;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    throw new WorkflowError(`Không kết nối được Chrome Riot để đăng xuất: ${lastError?.message || 'quá thời gian'}`, 'RIOT_REUSE_CONNECT');
  }

  async resetReusableManualRiotBrowser() {
    if (!this.manualBrowserProcess || this.manualBrowserExited) return;
    this.log('info', 'B6: đang đăng xuất Riot và chuẩn bị lại Chrome cho lượt kế tiếp.');
    const browser = await this.connectToManualRiotBrowser();
    const context = browser.contexts()[0];
    if (!context) throw new WorkflowError('Không tìm thấy profile Chrome Riot đang mở.', 'RIOT_REUSE_CONTEXT');
    const openPages = context.pages().filter((page) => !page.isClosed());
    let keeper = openPages.find((page) => /^https:\/\/www\.riotgames\.com(?:[/?#]|$)/i.test(page.url()));
    if (!keeper) keeper = openPages.find((page) => !isTokenUrl(page.url()));
    if (!keeper) keeper = await context.newPage();

    let loggedOutThroughUi = false;
    try {
      await keeper.goto(this.config.urls.riotHome, { waitUntil: 'domcontentloaded' });
      const menuClicked = await clickFirst(keeper, this.config.selectors.riot.accountMenus, 3000);
      if (menuClicked) {
        loggedOutThroughUi = await clickFirst(keeper, this.config.selectors.riot.logoutButtons, 5000);
        if (loggedOutThroughUi) await sleep(800);
      }
    } catch {
      // Cookie and storage cleanup below is the deterministic fallback.
    }

    await context.clearCookies({ domain: /(^|\.)riotgames\.com$/i }).catch(() => {});
    const session = await context.newCDPSession(keeper).catch(() => null);
    if (session) {
      for (const origin of [
        'https://www.riotgames.com',
        'https://auth.riotgames.com',
        'https://authenticate.riotgames.com',
        'https://account.riotgames.com'
      ]) {
        await session.send('Storage.clearDataForOrigin', {
          origin,
          storageTypes: 'local_storage,session_storage,indexeddb,websql,service_workers,cache_storage'
        }).catch(() => {});
      }
      await session.detach().catch(() => {});
    }
    for (const page of context.pages()) {
      if (page !== keeper && !page.isClosed()) await page.close().catch(() => {});
    }
    await keeper.goto(this.config.urls.riotHome, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await keeper.bringToFront().catch(() => {});
    this.manualLoginConfirmed = false;
    this.manualSessionClean = true;
    this.log('info', loggedOutThroughUi
      ? 'Đã đăng xuất Riot; Chrome được giữ lại cho lượt tiếp theo.'
      : 'Đã xóa phiên Riot; Chrome được giữ lại cho lượt tiếp theo.');
  }

  async cleanupManualRiotBrowser() {
    const child = this.manualBrowserProcess;
    this.manualBrowserProcess = null;
    this.manualCdpBrowser = null;
    this.manualDebugPort = null;
    this.manualSessionClean = false;
    this.manualLoginConfirmed = false;
    this.manualLoginResolve = null;
    this.manualLoginReject = null;
    if (child && !this.manualBrowserExited && !child.killed) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(3000)
      ]);
    }
    this.manualBrowserExited = false;
    fs.rmSync(this.riotProfileDir, { recursive: true, force: true });
  }

  async waitForRiotLogin(page) {
    const timeout = this.headless ? this.config.timeouts.loginHeadlessMs : this.config.timeouts.loginVisibleMs;
    const deadline = Date.now() + timeout;
    let manualNoticeSent = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) return;
      const url = page.url();
      const passwordVisible = await firstVisible(page, this.config.selectors.riot.passwordInputs, 50);
      if (!isRiotAuthUrl(url) && !passwordVisible) return;
      const loginError = await firstVisible(page, this.config.selectors.riot.loginErrors || [], 50);
      if (loginError) {
        throw new WorkflowError('Riot báo ID hoặc mật khẩu không đúng.', 'RIOT_CREDENTIALS_INVALID');
      }
      const twoFactor = await firstVisible(page, this.config.selectors.riot.twoFactorInputs, 50);
      if (twoFactor && this.headless) {
        throw new WorkflowError('Riot yêu cầu 2FA. Hãy chạy luồng ở chế độ hiện trình duyệt để nhập mã.', 'RIOT_2FA');
      }
      if (twoFactor && !manualNoticeSent) {
        this.log('warn', 'Riot yêu cầu 2FA/xác minh. Hãy hoàn tất trực tiếp trong cửa sổ trình duyệt.');
        manualNoticeSent = true;
      }
      await sleep(750);
    }
    throw new WorkflowError('Đăng nhập Riot quá thời gian hoặc thông tin tài khoản không đúng.', 'RIOT_LOGIN_TIMEOUT');
  }

  async obtainTokenFromMenzu() {
    this.log('info', 'B2: yêu cầu liên kết Riot từ Menzu.');
    let page = this.menzuPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.menzuPage = page;
    this.activePage = page;
    await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    if (isMenzuLogin(page.url())) {
      throw new SetupRequiredError('Phiên Menzu đã hết hạn. Cần đăng nhập lại profile.');
    }

    const clicked = await clickFirst(page, this.config.selectors.menzu.riotLoginButtons, this.config.timeouts.actionMs * 2);
    if (!clicked) {
      throw new WorkflowError('Không tìm thấy nút “Đăng nhập Riot Games” trên Menzu.', 'SELECTOR_MENZU_RIOT');
    }

    const deadline = Date.now() + this.config.timeouts.tokenMs;
    let authorizeAttempted = false;
    let loginFormSeenAt = null;
    while (Date.now() < deadline) {
      const pages = this.context.pages();
      for (const candidate of pages) {
        if (isTokenUrl(candidate.url())) {
          const tokenUrl = candidate.url();
          this.activePage = candidate;
          this.log('info', 'Đã nhận URL token (đã ẩn khỏi log).');
          return tokenUrl;
        }
      }
      if (!authorizeAttempted) {
        const authPage = pages.find((candidate) => isRiotAuthUrl(candidate.url()));
        if (authPage) {
          const loginInput = await firstVisible(authPage, this.config.selectors.riot.passwordInputs, 50);
          if (loginInput) {
            loginFormSeenAt ||= Date.now();
            if (Date.now() - loginFormSeenAt > 1500) {
              throw new WorkflowError(
                'Phiên Riot chưa đăng nhập. Hãy chạy lại và hoàn tất đăng nhập trong Chrome thường trước khi đóng cửa sổ.',
                'RIOT_MANUAL_LOGIN_REQUIRED'
              );
            }
            await sleep(300);
            continue;
          }
          loginFormSeenAt = null;
          const authorize = await firstVisible(authPage, this.config.selectors.menzu.authorizeButtons, 250);
          if (authorize) {
            await authorize.click().catch(() => {});
            authorizeAttempted = true;
          }
        }
      }
      await sleep(300);
    }
    throw new WorkflowError('Không nhận được URL token localhost từ Riot.', 'TOKEN_TIMEOUT');
  }

  async submitToken(tokenUrl) {
    let page = this.menzuPage;
    if (!page || page.isClosed()) page = await this.context.newPage();
    this.menzuPage = page;
    this.activePage = page;
    await page.bringToFront().catch(() => {});
    this.log('info', 'B3: đang gửi token sang Menzu.');
    if (!/menzu\.lol\/checkskin/i.test(page.url())) {
      await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    }
    if (isMenzuLogin(page.url())) throw new SetupRequiredError('Phiên Menzu đã hết hạn.');

    await this.scrollToArchive(page);
    const existingAccountCard = await this.findArchiveCardByAccount(page, this.currentAccount, 1000);
    if (existingAccountCard) {
      this.log('info', 'Tài khoản đã có trong Kho lưu trữ; tiếp tục dùng card hiện có.');
      return;
    }
    const cardsBefore = await this.findArchiveCards(page, 1000);
    const beforeCount = cardsBefore?.count || 0;
    if (beforeCount === 1) {
      this.log('warn', 'Kho lưu trữ đang có đúng 1 card từ lần check trước; tiếp tục xử lý card đó thay vì gửi token trùng.');
      return;
    }
    const input = await firstVisible(page, this.config.selectors.menzu.tokenInputs, this.config.timeouts.actionMs * 2);
    if (!input) throw new WorkflowError('Không tìm thấy ô dán link token trên Menzu.', 'SELECTOR_TOKEN_INPUT');
    this.sensitive = true;
    try {
      await input.fill(tokenUrl);
      const clicked = await clickFirst(page, this.config.selectors.menzu.checkButtons, this.config.timeouts.actionMs);
      if (!clicked) throw new WorkflowError('Không tìm thấy nút tiến hành check.', 'SELECTOR_CHECK_BUTTON');

      const deadline = Date.now() + this.config.timeouts.checkResultMs;
      while (Date.now() < deadline) {
        await this.scrollToArchive(page);
        const accountCard = await this.findArchiveCardByAccount(page, this.currentAccount, 300);
        if (accountCard) {
          this.log('info', 'Menzu đã hiển thị tài khoản trong Kho lưu trữ.');
          return;
        }
        const cards = await this.findArchiveCards(page, 500);
        if (cards && cards.count > beforeCount) {
          this.log('info', 'Menzu đã thêm tài khoản vào kho lưu trữ.');
          return;
        }
        await sleep(500);
      }
      throw new WorkflowError('Menzu không trả về tài khoản trong thời gian chờ.', 'MENZU_CHECK_TIMEOUT');
    } finally {
      await input.fill('').catch(() => {});
      this.sensitive = false;
    }
  }

  async findArchiveCards(page, timeoutMs = this.config.timeouts.actionMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const configured = await firstSelectorWithCount(
        page,
        this.config.selectors.menzu.archiveCards,
        1,
        Math.min(250, Math.max(1, deadline - Date.now()))
      );
      if (configured) return configured;

      const updateLabels = page.getByText(/Cập nhật lúc/i);
      const semanticCards = updateLabels.locator('xpath=ancestor::*[.//button][1]');
      const count = await semanticCards.count().catch(() => 0);
      if (count) return { locator: semanticCards, count, selector: 'semantic:Cập nhật lúc' };
      await sleep(200);
    }
    return null;
  }

  async scrollToArchive(page) {
    const archiveHeading = page.getByText(/Kho lưu trữ/i).first();
    if (await archiveHeading.count().catch(() => 0)) {
      await archiveHeading.scrollIntoViewIfNeeded().catch(() => {});
      return;
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  }

  async findArchiveCardByAccount(page, accountId, timeoutMs = this.config.timeouts.actionMs) {
    if (!accountId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = page.getByText(String(accountId), { exact: false });
      const count = Math.min(await matches.count().catch(() => 0), 20);
      for (let index = 0; index < count; index += 1) {
        const match = matches.nth(index);
        if (!await match.isVisible().catch(() => false)) continue;
        const card = match.locator(
          "xpath=ancestor::*[self::article or self::li or @role='listitem' or @role='button' or self::button or self::a or contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'card') or contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'account')][1]"
        );
        if (await card.count().catch(() => 0)) return card.first();
        return match;
      }
      await sleep(200);
    }
    return null;
  }

  async findLatestArchiveCard(page, timeoutMs = this.config.timeouts.actionMs) {
    await this.scrollToArchive(page);
    const result = await this.findArchiveCards(page, timeoutMs);
    if (!result?.count) return null;
    return result.locator.last();
  }

  async pickArchiveCard(page) {
    await this.scrollToArchive(page);
    const result = await this.findArchiveCards(page, this.config.timeouts.actionMs * 2);
    if (!result) throw new WorkflowError('Không tìm thấy thẻ tài khoản trong kho lưu trữ.', 'SELECTOR_ARCHIVE_CARD');
    if (result.count === 1) return result.locator.first();
    const matches = result.locator.filter({ hasText: this.currentAccount || '' });
    if (this.currentAccount && await matches.count()) return matches.last();
    this.log('warn', 'Card Menzu không chứa Riot login ID; đang dùng card được cập nhật gần nhất trong Kho lưu trữ.');
    return result.locator.last();
  }

  async openNightMarketAndCapture(accountId) {
    const page = this.menzuPage;
    this.activePage = page;
    this.log('info', 'B4: đang mở và chụp 6 thẻ Night Market.');
    const accountCard = await this.pickArchiveCard(page);
    await accountCard.click();
    const tabClicked = await clickFirst(page, this.config.selectors.menzu.nightMarketTabs, this.config.timeouts.actionMs * 2);
    if (!tabClicked) throw new WorkflowError('Không tìm thấy tab Night Market/Chợ Đêm.', 'SELECTOR_NIGHT_TAB');

    const cards = await firstSelectorWithCount(
      page,
      this.config.selectors.menzu.nightMarketCards,
      6,
      this.config.timeouts.actionMs * 2
    );
    if (!cards) throw new WorkflowError('Không tìm thấy đủ 6 thẻ Night Market.', 'SELECTOR_NIGHT_CARDS');
    for (let index = 0; index < 6; index += 1) {
      await cards.locator.nth(index).click();
      await sleep(350);
    }
    await sleep(1500);

    const imagePath = this.resultStore.imagePath(accountId);
    const panel = await firstVisible(page, this.config.selectors.menzu.nightMarketPanels, 3000);
    if (panel) {
      await panel.screenshot({ path: imagePath });
    } else {
      await page.screenshot({ path: imagePath, fullPage: true });
      this.log('warn', 'Không định vị được riêng khung Night Market; đã chụp toàn trang.');
    }
    return imagePath;
  }

  async deleteMenzuAccount() {
    this.log('info', 'B5: xóa tài khoản khỏi kho Menzu.');
    const page = this.menzuPage;
    await page.goto(this.config.urls.menzuCheck, { waitUntil: 'domcontentloaded' });
    await this.scrollToArchive(page);
    const cardsBefore = await this.findArchiveCards(page, 2000);
    if (!cardsBefore?.count) {
      throw new WorkflowError('Không tìm thấy thẻ tài khoản trong kho lưu trữ.', 'SELECTOR_ARCHIVE_CARD');
    }
    const beforeCount = cardsBefore?.count || 0;
    const card = await this.pickArchiveCard(page);
    let deleteButton = null;
    for (const selector of this.config.selectors.menzu.deleteButtons) {
      const candidate = card.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        deleteButton = candidate;
        break;
      }
    }
    if (!deleteButton) {
      deleteButton = await firstVisible(page, this.config.selectors.menzu.deleteButtons, this.config.timeouts.actionMs);
    }
    if (!deleteButton) throw new WorkflowError('Không tìm thấy nút thùng rác của tài khoản.', 'SELECTOR_DELETE');
    await deleteButton.click();
    const confirm = await firstVisible(page, this.config.selectors.menzu.confirmDeleteButtons, 3000);
    if (confirm) await confirm.click();
    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      const remaining = await this.findArchiveCards(page, 300);
      if ((remaining?.count || 0) < beforeCount) return;
      await sleep(250);
    }
    throw new WorkflowError('Menzu chưa xóa card khỏi Kho lưu trữ.', 'MENZU_DELETE_TIMEOUT');
  }

  async logoutRiot() {
    this.log('info', 'B6: đăng xuất Riot.');
    const page = this.riotPage;
    if (page && !page.isClosed()) {
      await page.goto(this.config.urls.riotHome, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const menuClicked = await clickFirst(page, this.config.selectors.riot.accountMenus, 3000).catch(() => false);
      if (menuClicked) {
        const loggedOut = await clickFirst(page, this.config.selectors.riot.logoutButtons, 5000).catch(() => false);
        if (loggedOut) {
          await sleep(1000);
          return;
        }
      }
    }
    await this.cleanupRiotSession();
    this.log('warn', 'Không thấy nút đăng xuất; đã xóa riêng dữ liệu phiên Riot (không ảnh hưởng Menzu).');
  }

  async cleanupRiotSession() {
    if (!this.context) return;
    await this.context.clearCookies({ domain: /(^|\.)riotgames\.com$/i }).catch(() => {});
    const riotOrigins = [
      'https://www.riotgames.com',
      'https://auth.riotgames.com',
      'https://authenticate.riotgames.com',
      'https://account.riotgames.com'
    ];
    const usablePage = this.context.pages().find((page) => !page.isClosed());
    if (!usablePage) return;
    const session = await this.context.newCDPSession(usablePage).catch(() => null);
    if (!session) return;
    for (const origin of riotOrigins) {
      await session.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'local_storage,session_storage,indexeddb,websql,service_workers,cache_storage'
      }).catch(() => {});
    }
    await session.detach().catch(() => {});
  }

  async saveErrorScreenshot(accountId) {
    const page = this.activePage;
    if (!page || page.isClosed()) return;
    const errorDir = ensureDir(path.join(this.root, 'runtime', 'errors'));
    const file = path.join(errorDir, `${safeFilename(accountId)}_worker-${this.id}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 10000 });
  }
}

class BrowserManager {
  constructor({ root, config, events, resultStore }) {
    this.root = root;
    this.config = config;
    this.events = events;
    this.resultStore = resultStore;
    this.workers = [];
    this.defaultHeadless = false;
    this.previewEnabled = true;
    this.closeRiotAfterToken = false;
    this.running = false;
  }

  async configure(count, headless, previewEnabled, closeRiotAfterToken = false) {
    if (this.running) throw new Error('Hãy dừng hàng đợi trước khi đổi số luồng.');
    const normalizedCount = Math.max(1, Math.min(10, Number(count) || 1));
    this.defaultHeadless = Boolean(headless);
    this.previewEnabled = previewEnabled !== false;
    this.closeRiotAfterToken = Boolean(closeRiotAfterToken);
    while (this.workers.length > normalizedCount) {
      const worker = this.workers.pop();
      await worker.close();
    }
    while (this.workers.length < normalizedCount) {
      this.workers.push(new BrowserWorker({
        id: this.workers.length + 1,
        root: this.root,
        config: this.config,
        events: this.events,
        resultStore: this.resultStore,
        previewEnabled: () => this.previewEnabled,
        closeRiotAfterToken: this.closeRiotAfterToken
      }));
    }
    await Promise.all(this.workers.map((worker) => worker.setCloseRiotAfterToken(this.closeRiotAfterToken)));
    this.events.changed();
  }

  getWorker(id) {
    const worker = this.workers.find((candidate) => candidate.id === Number(id));
    if (!worker) throw new Error(`Không tồn tại luồng ${id}.`);
    return worker;
  }

  async openSetup(id) {
    const worker = this.getWorker(id);
    await worker.launch(false, true);
  }

  async verify(id) {
    return this.getWorker(id).verifyMenzuSession();
  }

  async close(id) {
    await this.getWorker(id).close();
  }

  async inspectMenzuArchive(id) {
    return this.getWorker(id).inspectMenzuArchive();
  }

  async inspectMenzuNightMarket(id) {
    return this.getWorker(id).inspectMenzuNightMarket();
  }

  resumeManualLogin(id) {
    this.getWorker(id).resumeManualLogin();
  }

  async start(queue) {
    if (this.running) throw new Error('Hàng đợi đang chạy.');
    if (!queue.summary().queued) throw new Error('Không có tài khoản nào đang chờ.');
    this.running = true;
    this.events.changed();
    const jobs = this.workers.map((worker) => worker.run(queue, this.defaultHeadless));
    Promise.allSettled(jobs).finally(() => this.refreshRunning());
  }

  async startWorker(id, queue) {
    const worker = this.getWorker(id);
    if (worker.loopPromise) throw new Error(`Luồng ${id} đang chạy.`);
    if (!queue.summary().queued) throw new Error('Không có tài khoản nào đang chờ.');
    this.running = true;
    this.events.changed();
    worker.run(queue, this.defaultHeadless).finally(() => this.refreshRunning());
  }

  refreshRunning() {
    this.running = this.workers.some((worker) => Boolean(worker.loopPromise));
    this.events.changed();
  }

  stop() {
    for (const worker of this.workers) worker.requestStop();
    this.events.changed();
  }

  async shutdown() {
    this.stop();
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
  }

  publicState() {
    return {
      running: this.running,
      defaultHeadless: this.defaultHeadless,
      previewEnabled: this.previewEnabled,
      closeRiotAfterToken: this.closeRiotAfterToken,
      workers: this.workers.map((worker) => worker.publicState())
    };
  }
}

module.exports = { BrowserManager, SetupRequiredError, WorkflowError, firstVisible, isTokenUrl };
