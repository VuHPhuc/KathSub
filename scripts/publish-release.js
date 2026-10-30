#!/usr/bin/env node
/**
 * scripts/publish-release.js
 * Xuất bản GitHub Release cho KathSub (VuHPhuc/KathSub).
 * 
 * Tính năng:
 * - Đọc phiên bản động từ package.json.
 * - Lấy GitHub Token tự động từ `git credential fill` hoặc biến môi trường GITHUB_TOKEN / GH_TOKEN.
 * - Đọc RELEASE_NOTES_<version>.md chuẩn UTF-8 (tránh mojibake L-019).
 * - Tạo/Cập nhật GitHub Release (draft: false, prerelease: false).
 * - Stream upload 4 file: KathSub-Setup-<version>.exe, KathSub Portable <version>.exe, .blockmap, latest.yml.
 * - Idempotent: Tự xóa asset cũ nếu bị đứt mạng upload lại (tránh lỗi 422 already_exists).
 * - Kiểm chứng sau phát hành qua API /releases/latest.
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(PROJECT_ROOT, 'package.json'));

const OWNER = 'VuHPhuc';
const REPO = 'KathSub';
const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const RELEASE_NAME = `KathSub v${VERSION} — Khung phụ đề co giãn, model Anime tiếng Nhật & dịch theo thể loại video`;

const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');
const NOTES_FILE = path.join(RELEASE_DIR, `RELEASE_NOTES_${VERSION}.md`);

const ASSETS = [
  { name: `KathSub-Setup-${VERSION}.exe`, path: path.join(RELEASE_DIR, `KathSub-Setup-${VERSION}.exe`), type: 'application/octet-stream' },
  { name: `KathSub Portable ${VERSION}.exe`, path: path.join(RELEASE_DIR, `KathSub Portable ${VERSION}.exe`), type: 'application/octet-stream' },
  { name: `KathSub-Setup-${VERSION}.exe.blockmap`, path: path.join(RELEASE_DIR, `KathSub-Setup-${VERSION}.exe.blockmap`), type: 'application/octet-stream' },
  { name: 'latest.yml', path: path.join(RELEASE_DIR, 'latest.yml'), type: 'application/octet-stream' },
];

function getGitHubToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }
  if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) {
    return process.env.GH_TOKEN.trim();
  }

  try {
    const input = 'protocol=https\nhost=github.com\n\n';
    const output = child_process.execSync('git credential fill', {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith('password=')) {
        return line.slice('password='.length).trim();
      }
    }
  } catch (err) {
    try {
      const ghToken = child_process.execSync('gh auth token', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      if (ghToken) return ghToken;
    } catch (_) {}
  }
  return null;
}

function githubRequest(urlStr, options = {}, token) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlStr.startsWith('http') ? urlStr : `https://api.github.com${urlStr}`);
    const headers = {
      'User-Agent': 'KathSub-Release-Agent',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    };

    let bodyBuf = null;
    if (options.body) {
      if (Buffer.isBuffer(options.body)) {
        bodyBuf = options.body;
      } else if (typeof options.body === 'object') {
        bodyBuf = Buffer.from(JSON.stringify(options.body), 'utf8');
        headers['Content-Type'] = 'application/json; charset=utf-8';
      } else if (typeof options.body === 'string') {
        bodyBuf = Buffer.from(options.body, 'utf8');
      }
      headers['Content-Length'] = bodyBuf.length;
    }

    const req = https.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: targetUrl.pathname + targetUrl.search,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } else {
          const err = new Error(`GitHub API ${res.statusCode} ${res.statusMessage}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`);
          err.status = res.statusCode;
          err.data = parsed;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function uploadAsset(uploadUrlStr, filePath, fileName, contentType, token) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const cleanUrl = uploadUrlStr.replace(/\{.*?\}/, '');
    const targetUrl = new URL(cleanUrl);
    targetUrl.searchParams.set('name', fileName);

    const headers = {
      'User-Agent': 'KathSub-Release-Agent',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${token}`,
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': stat.size,
    };

    const req = https.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        if (res.statusCode === 201) {
          resolve(parsed);
        } else {
          const err = new Error(`Upload error ${res.statusCode}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`);
          err.status = res.statusCode;
          err.data = parsed;
          reject(err);
        }
      });
    });

    req.on('error', reject);

    let uploadedBytes = 0;
    let lastPercent = -1;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const pct = Math.floor((uploadedBytes / stat.size) * 100);
      if (pct !== lastPercent && (pct % 5 === 0 || uploadedBytes === stat.size)) {
        lastPercent = pct;
        const mb = (uploadedBytes / (1024 * 1024)).toFixed(1);
        const totalMb = (stat.size / (1024 * 1024)).toFixed(1);
        process.stdout.write(`\r   ⏳ Đang tải [${fileName}]: ${mb}/${totalMb} MB (${pct}%)`);
      }
    });
    stream.on('end', () => {
      process.stdout.write('\n');
    });
    stream.on('error', (err) => {
      req.destroy(err);
      reject(err);
    });

    stream.pipe(req);
  });
}

async function main() {
  console.log('====================================================');
  console.log(`🚀 KATHSUB RELEASE PUBLISHER — ${TAG}`);
  console.log('====================================================\n');

  // 1. Kiểm tra file cục bộ
  console.log('1. Kiểm tra tệp build cục bộ:');
  if (!fs.existsSync(NOTES_FILE)) {
    throw new Error(`Không tìm thấy file Release Notes: ${NOTES_FILE}`);
  }
  const releaseNotes = fs.readFileSync(NOTES_FILE, 'utf8');
  console.log(`   ✓ Release Notes: ${path.basename(NOTES_FILE)} (${releaseNotes.length} ký tự UTF-8)`);

  for (const asset of ASSETS) {
    if (!fs.existsSync(asset.path)) {
      throw new Error(`Thiếu tệp build bắt buộc: ${asset.path}`);
    }
    const stat = fs.statSync(asset.path);
    console.log(`   ✓ ${asset.name} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
  }

  // Kiểm tra latest.yml
  const latestYmlContent = fs.readFileSync(path.join(RELEASE_DIR, 'latest.yml'), 'utf8');
  if (!latestYmlContent.includes(`version: ${VERSION}`) || !latestYmlContent.includes(`KathSub-Setup-${VERSION}.exe`)) {
    throw new Error(`Nội dung latest.yml không khớp phiên bản ${VERSION} hoặc tên file installer!`);
  }
  console.log(`   ✓ latest.yml hợp lệ (khớp phiên bản ${VERSION} và tên installer)\n`);

  // 2. Lấy GitHub Token
  console.log('2. Xác thực GitHub Token:');
  const token = getGitHubToken();
  if (!token) {
    throw new Error(
      'Không tìm thấy GitHub token qua `git credential fill` hay biến GITHUB_TOKEN.\n' +
      'Vui lòng chạy: $env:GITHUB_TOKEN="ghp_..." trước khi thực hiện.'
    );
  }
  console.log(`   ✓ Đã lấy được GitHub token (độ dài: ${token.length})\n`);

  // 3. Kiểm tra kết nối repo
  console.log(`3. Kiểm tra quyền truy cập repo ${OWNER}/${REPO}:`);
  const repoRes = await githubRequest(`/repos/${OWNER}/${REPO}`, {}, token);
  console.log(`   ✓ Kết nối thành công tới ${repoRes.data.full_name} (default branch: ${repoRes.data.default_branch})\n`);

  // 4. Tạo hoặc cập nhật Release
  console.log(`4. Kiểm tra Release tag ${TAG} trên GitHub:`);
  let release = null;
  try {
    const existing = await githubRequest(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, {}, token);
    release = existing.data;
    console.log(`   ℹ️ Release ${TAG} đã tồn tại (ID: ${release.id}). Cập nhật thông tin...`);
    const updateRes = await githubRequest(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      body: {
        tag_name: TAG,
        target_commitish: 'main',
        name: RELEASE_NAME,
        body: releaseNotes,
        draft: false,
        prerelease: false,
      },
    }, token);
    release = updateRes.data;
    console.log(`   ✓ Đã cập nhật tiêu đề và ghi chú release.`);
  } catch (err) {
    if (err.status === 404) {
      console.log(`   ℹ️ Tạo mới GitHub Release ${TAG}...`);
      const createRes = await githubRequest(`/repos/${OWNER}/${REPO}/releases`, {
        method: 'POST',
        body: {
          tag_name: TAG,
          target_commitish: 'main',
          name: RELEASE_NAME,
          body: releaseNotes,
          draft: false,
          prerelease: false,
        },
      }, token);
      release = createRes.data;
      console.log(`   ✓ Đã tạo Release thành công (ID: ${release.id})`);
    } else {
      throw err;
    }
  }

  console.log(`   URL: ${release.html_url}\n`);

  // 5. Upload Assets
  console.log('5. Tải lên danh sách assets:');
  const currentAssetsRes = await githubRequest(`/repos/${OWNER}/${REPO}/releases/${release.id}/assets`, {}, token);
  const currentAssets = currentAssetsRes.data || [];

  for (const asset of ASSETS) {
    const existingAsset = currentAssets.find((a) => a.name === asset.name);
    if (existingAsset) {
      console.log(`   ⚠️ Asset ${asset.name} đã tồn tại (ID: ${existingAsset.id}), đang xoá để tải mới...`);
      await githubRequest(`/repos/${OWNER}/${REPO}/releases/assets/${existingAsset.id}`, { method: 'DELETE' }, token);
      console.log(`   ✓ Đã xoá asset cũ.`);
    }

    console.log(`   ⬆️ Đang tải lên: ${asset.name}...`);
    await uploadAsset(release.upload_url, asset.path, asset.name, asset.type, token);
    console.log(`   ✓ Hoàn tất tải lên: ${asset.name}`);
  }
  console.log('');

  // 6. Kiểm chứng Smoke Test sau phát hành
  console.log('6. Kiểm chứng sau phát hành qua API /releases/latest:');
  const latestRes = await githubRequest(`/repos/${OWNER}/${REPO}/releases/latest`, {}, token);
  const latest = latestRes.data;

  if (latest.tag_name !== TAG) {
    console.warn(`   ⚠️ Cảnh báo: /releases/latest hiện vẫn trỏ về ${latest.tag_name}. Có thể mất vài giây để GitHub đồng bộ cache.`);
  } else {
    console.log(`   ✓ Release mới nhất trên GitHub hiện là: ${latest.tag_name} (${latest.name})`);
  }

  console.log('   ✓ Danh sách assets đã publish:');
  for (const a of latest.assets || []) {
    console.log(`     - ${a.name} (${(a.size / (1024 * 1024)).toFixed(2)} MB, state: ${a.state})`);
  }

  console.log('\n====================================================');
  console.log(`🎉 PHÁT HÀNH THÀNH CÔNG KATHSUB ${TAG}!`);
  console.log(`👉 Link Release: ${release.html_url}`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('\n❌ [LỖI PHÁT HÀNH]:', err.message);
  process.exit(1);
});
