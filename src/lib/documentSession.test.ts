import { DocumentSession } from './documentSession';

describe('方案异步请求', () => {
  it('保存期间继续编辑时，旧版本的成功响应不能清除未保存标记', () => {
    const session = new DocumentSession();
    session.edit();
    const saving = session.capture();
    session.edit();
    expect(session.isSameDocument(saving)).toBe(true);
    expect(session.isUnchanged(saving)).toBe(false);
    expect(session.isUnchanged(session.capture())).toBe(true);
  });

  it('切换方案后，旧保存和加载响应都不能应用', () => {
    const session = new DocumentSession();
    const saving = session.capture();
    const loading = session.beginLoad();
    session.reset();
    expect(session.isSameDocument(saving)).toBe(false);
    expect(session.canApplyLoad(loading)).toBe(false);
  });

  it('连续点击两张地图，只有最后点击的请求可以应用', () => {
    const session = new DocumentSession();
    const first = session.beginLoad();
    const second = session.beginLoad();
    expect(session.canApplyLoad(first)).toBe(false);
    expect(session.canApplyLoad(second)).toBe(true);
  });

  it('加载等待期间的新编辑不能被远端地图覆盖', () => {
    const session = new DocumentSession();
    const loading = session.beginLoad();
    session.edit();
    expect(session.isLatestLoad(loading)).toBe(true);
    expect(session.canApplyLoad(loading)).toBe(false);
  });
});
