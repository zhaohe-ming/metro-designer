const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractProjectArg, createProjectController } = require('./projectIo.cjs');

test('extractProjectArg picks existing .metro or .json path and ignores flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-arg-test-'));
  const metroFile = path.join(dir, 'city.metro');
  fs.writeFileSync(metroFile, '{}', 'utf8');
  try {
    assert.equal(
      extractProjectArg(['MetroDesigner.exe', '--allow-file', metroFile], dir, 1),
      metroFile
    );
    assert.equal(
      extractProjectArg(['MetroDesigner.exe', path.join(dir, 'missing.metro')], dir, 1),
      null
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('projectController enforces dialog authorization before silent in-place overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metro-proj-test-'));
  const userDataDir = path.join(dir, 'userdata');
  const docsDir = path.join(dir, 'docs');
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  let saveDialogCount = 0;
  let nextSaveTarget = path.join(docsDir, 'first-save.metro');
  const progressCalls = [];

  const controller = createProjectController({
    app: {
      getPath(name) {
        if (name === 'userData') return userDataDir;
        if (name === 'documents') return docsDir;
        return downloadsDir;
      },
      addRecentDocument() {},
      clearRecentDocuments() {}
    },
    dialog: {
      async showOpenDialog() {
        return { canceled: false, filePaths: [nextSaveTarget] };
      },
      async showSaveDialog() {
        saveDialogCount += 1;
        return { canceled: false, filePath: nextSaveTarget };
      }
    },
    getWindow: () => ({
      isDestroyed: () => false,
      setProgressBar: (v) => progressCalls.push(v)
    })
  });

  try {
    // 1) 未授权的任意磁盘路径不能静默覆盖，必须触发系统保存对话框
    const unauthorizedAttempt = path.join(docsDir, 'arbitrary.metro');
    const saved1 = await controller.saveProjectFile({
      filePath: unauthorizedAttempt,
      suggestedName: '测试方案',
      content: '{"lines":[],"stations":[]}'
    });
    assert.equal(saveDialogCount, 1);
    assert.equal(saved1.filePath, nextSaveTarget);
    assert.equal(fs.readFileSync(nextSaveTarget, 'utf8'), '{"lines":[],"stations":[]}');

    // 2) 已由用户在保存对话框确认过的路径，后续 Ctrl+S 直接原地写盘，不再弹保存对话框
    const saved2 = await controller.saveProjectFile({
      filePath: nextSaveTarget,
      suggestedName: '测试方案',
      content: '{"lines":[1],"stations":[]}'
    });
    assert.equal(saveDialogCount, 1);
    assert.equal(saved2.filePath, nextSaveTarget);
    assert.equal(fs.readFileSync(nextSaveTarget, 'utf8'), '{"lines":[1],"stations":[]}');

    // 3) saveAs=true 强制弹出另存为对话框
    nextSaveTarget = path.join(docsDir, 'copy.metro');
    const saved3 = await controller.saveProjectFile({
      filePath: saved2.filePath,
      suggestedName: '测试方案副本',
      content: '{"lines":[1,2],"stations":[]}',
      saveAs: true
    });
    assert.equal(saveDialogCount, 2);
    assert.equal(saved3.filePath, nextSaveTarget);
    assert.equal(controller.getRecentFiles().length, 2);

    // 4) 原生二进制导出（MP4 视频）
    nextSaveTarget = path.join(downloadsDir, 'demo.mp4');
    const exp = await controller.saveExportFile({
      suggestedName: 'demo.mp4',
      mimeType: 'video/mp4',
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    });
    assert.equal(exp.canceled, false);
    assert.equal(fs.readFileSync(nextSaveTarget).length, 8);
    assert.deepEqual(progressCalls, [2, -1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
