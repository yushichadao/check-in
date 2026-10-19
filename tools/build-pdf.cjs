'use strict';
/* 将三册说明书 HTML 渲染为「带配图 · 带页码 · 封面/封底整幅铺满」的 A4 PDF。
 *
 * 背景：Chromium 的 `@page` 页码边距框（@bottom-center）与 Playwright 的页脚模板
 * （displayHeaderFooter）会叠在同一个位置，两行页码重影；而页脚模板又会在所有页
 * （含封面）加页码。因此页码唯一来源定为「这里的页脚模板」，三册 HTML 不再声明
 * @bottom-center。为同时满足「封面/封底整幅不留白」与「正文有页码」，采用三段渲染后合并：
 *   ① 封面：仅渲染 .cover，页边距 0，整幅铺满，无页码；
 *   ② 正文：隐藏封面/封底，保留 15mm 页边距，用页脚模板输出「第 X 页」；
 *   ③ 封底：仅渲染 .backcover，页边距 0，整幅铺满，无页码；
 * 再用 pdf-lib 合并为最终 PDF。
 *
 * 需 playwright + chromium + pdf-lib。用法：npm run build:pdf
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const FILES = [
  { f: 'manual-ops', label: '运维端' },
  { f: 'manual-admin', label: '管理端' },
  { f: 'manual-user', label: '用户端' }
];
const VERSION = (() => { try { return require('../package.json').version || '1.0.0'; } catch (e) { return '1.0.0'; } })();
const DATE = new Date().toISOString().slice(0, 10);
const M_CONTENT = '15mm 15mm 18mm 15mm';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const { f, label } of FILES) {
    const htmlPath = path.join(ROOT, f + '.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace(/\{\{VERSION\}\}/g, VERSION).replace(/\{\{DATE\}\}/g, DATE);
    const tmp = path.join(ROOT, f + '.__tmp.html');
    fs.writeFileSync(tmp, html, 'utf8');
    const url = 'file://' + tmp;

    async function renderPass(css, pdfOpts) {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      if (css) await page.addStyleTag({ content: css });
      await page.waitForTimeout(250);
      const buf = await page.pdf(Object.assign({ format: 'A4', preferCSSPageSize: true, printBackground: true }, pdfOpts));
      await page.close();
      return buf;
    }

    // ① 封面：整幅（页边距 0，取消分页前后的强制换页，避免多余空白页）
    const cover = await renderPass(
      '@page{margin:0 !important} @page:first{margin:0 !important} .cover ~ *{display:none !important} ' +
      '.cover{page-break-after:auto !important; break-after:auto !important}',
      {}
    );

    // ② 正文：保留页边距，输出页码（第 X 页 / 共 Y 页）
    //    页脚模板是本 PDF 页码的唯一来源；HTML 里不要再写 @bottom-center，否则两行页码重叠。
    const content = await renderPass(
      `@page{margin:${M_CONTENT} !important} @page:first{margin:${M_CONTENT} !important} ` +
      '.cover{display:none !important} .backcover{display:none !important}',
      {
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate:
          `<div style="width:100%;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:8.5px;color:#9AA1AD;text-align:center;padding:0 0 4mm;">` +
          `班级签到系统 · ${label}说明书 · v${VERSION}　正文 第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`
      }
    );

    // ③ 封底：整幅
    const back = await renderPass(
      '@page{margin:0 !important} @page:first{margin:0 !important} .cover{display:none !important} ' +
      '.cover ~ *:not(.backcover){display:none !important} .backcover{page-break-before:auto !important; break-before:auto !important}',
      {}
    );

    // ④ 合并：封面 + 正文 + 封底
    const out = await PDFDocument.create();
    for (const buf of [cover, content, back]) {
      const src = await PDFDocument.load(new Uint8Array(buf));
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    fs.writeFileSync(path.join(ROOT, f + '.pdf'), await out.save());
    fs.unlinkSync(tmp);
    console.log(`已生成 PDF：${f}.pdf（v${VERSION} · ${DATE}，共 ${out.getPageCount()} 页）`);
  }
  await browser.close();
  console.log('PDF 生成完成。');
})().catch((e) => { console.error('PDF 生成失败：', e); process.exit(1); });
