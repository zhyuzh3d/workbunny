export async function mountProductInfo(root, pet) {
  if (!root || !pet.productInfo) return;
  try {
    const info = await pet.productInfo();
    const heading = document.createElement('h2'); heading.className = 'product-name'; heading.textContent = info.name + ' ' + info.subtitle;
    const intro = document.createElement('p'); intro.className = 'note'; intro.textContent = info.description;
    const facts = document.createElement('dl'); facts.className = 'product-facts';
    for (const [label, text] of [['版本', 'v' + info.version], ['作者', info.author], ['项目', info.source], ['授权', info.license], ['GitHub', info.repositoryLabel]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = text; facts.append(dt, dd);
    }
    const note = document.createElement('p'); note.className = 'note product-license'; note.textContent = info.licenseNote;
    const button = document.createElement('button'); button.className = 'mini product-repository'; button.textContent = '访问 GitHub 仓库 ↗'; button.title = '在外部浏览器中打开';
    const status = document.createElement('p'); status.className = 'note'; status.setAttribute('role', 'status');
    button.onclick = async () => { try { await pet.openRepository(); status.textContent = ''; } catch { status.textContent = '浏览器未能打开，请稍后重试。'; } };
    root.replaceChildren(heading, intro, facts, button, note, status);
  } catch { root.textContent = '软件信息读取失败，请重新打开。'; }
}
