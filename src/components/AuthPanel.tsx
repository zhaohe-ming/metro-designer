import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Input, Typography, message } from 'antd';
import {
  ArrowRightOutlined,
  LockOutlined,
  MailOutlined,
  ReloadOutlined,
  UserOutlined
} from '@ant-design/icons';
import authHeroImage from '../assets/auth-metro-hero.png';
import { api, LoginResult, UserDto } from '../api';

// 登录态切换：把所有"需要在登录卡里展示的中间态"集中在这里管，避免 App.tsx 处理多个分支。
// 状态机：
//   login → verify_required（注册或登录后未验证 → 提示 + 重发）
//   login → upgrade_required（老手机号账号 → 强制补邮箱并验证）
//   forgot → reset_sent（请求重置邮件 → 提示已发送）
//   register → verify_required
//   verify-email URL → verifying → ok | error
//   reset-password URL → reset_form → ok | error
type Mode =
  | 'login'
  | 'register'
  | 'forgot'
  | 'verify_pending'
  | 'upgrade_required'
  | 'reset_sent'
  | 'reset_form'        // 用户从邮件链接 /reset-password?token=… 进来
  | 'verifying_url'     // 用户从邮件链接 /verify-email?token=… 进来
  | 'verify_done';      // 验证成功后展示，自动登录后由父组件移除

interface AuthPanelProps {
  // 验证邮箱 / 重置密码成功后父组件接管：保存 token + user 并卸载 AuthPanel
  onAuthenticated: (payload: { token: string; user: UserDto }) => void | Promise<void>;
}

const { Title, Text, Paragraph } = Typography;

// 从 URL ?token=... 抠 token —— 注册 / 重置邮件用同一个机制
function readTokenFromUrl(): { kind: 'verify' | 'reset' | null; token: string } {
  if (typeof window === 'undefined') return { kind: null, token: '' };
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  const token = (params.get('token') || '').trim();
  if (!token) return { kind: null, token: '' };
  if (pathname.startsWith('/verify-email')) return { kind: 'verify', token };
  if (pathname.startsWith('/reset-password')) return { kind: 'reset', token };
  return { kind: null, token: '' };
}

const AuthPanel: React.FC<AuthPanelProps> = ({ onAuthenticated }) => {
  const initialTokenInUrl = useMemo(readTokenFromUrl, []);
  const [mode, setMode] = useState<Mode>(() => {
    if (initialTokenInUrl.kind === 'verify') return 'verifying_url';
    if (initialTokenInUrl.kind === 'reset') return 'reset_form';
    return 'login';
  });
  const [loading, setLoading] = useState(false);
  // 跨状态共享的数据
  const [pendingEmail, setPendingEmail] = useState('');
  const [upgradeToken, setUpgradeToken] = useState('');
  const [hint, setHint] = useState('');
  const [errorBanner, setErrorBanner] = useState('');

  // 一进页面就消费 URL 中的 verify token；用户体验上不让他多点一次
  useEffect(() => {
    if (initialTokenInUrl.kind !== 'verify') return;
    let cancelled = false;
    (async () => {
      try {
        const result = await api.verifyEmail(initialTokenInUrl.token);
        if (cancelled) return;
        // 验证成功 → 把 URL 清掉，避免刷新页面重复消费
        window.history.replaceState({}, '', '/');
        await onAuthenticated({ token: result.token, user: result.user });
      } catch (e: any) {
        if (cancelled) return;
        setMode('login');
        setErrorBanner(e?.message || '验证失败，请重新登录或重发验证邮件');
        window.history.replaceState({}, '', '/');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialTokenInUrl, onAuthenticated]);

  const switchMode = (next: Mode) => {
    setErrorBanner('');
    setHint('');
    setMode(next);
  };

  const handleLoginFinish = async (values: { account: string; password: string }) => {
    setLoading(true);
    setErrorBanner('');
    try {
      const result: LoginResult = await api.login(values);
      if (result.status === 'ok') {
        await onAuthenticated({ token: result.token, user: result.user });
        return;
      }
      if (result.status === 'verify_required') {
        setPendingEmail(result.email);
        switchMode('verify_pending');
        return;
      }
      if (result.status === 'upgrade_required') {
        setUpgradeToken(result.upgradeToken);
        setHint(result.hint || '为提升账户安全，请补充邮箱并完成验证');
        switchMode('upgrade_required');
        return;
      }
    } catch (e: any) {
      setErrorBanner(e?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterFinish = async (values: {
    email: string;
    password: string;
    confirm: string;
    username: string;
  }) => {
    setLoading(true);
    setErrorBanner('');
    try {
      const result = await api.register({
        email: values.email,
        password: values.password,
        username: values.username
      });
      setPendingEmail(result.email);
      switchMode('verify_pending');
    } catch (e: any) {
      setErrorBanner(e?.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotFinish = async (values: { email: string }) => {
    setLoading(true);
    setErrorBanner('');
    try {
      const result = await api.forgotPassword(values.email);
      setPendingEmail(result.email);
      switchMode('reset_sent');
    } catch (e: any) {
      setErrorBanner(e?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgradeFinish = async (values: { email: string }) => {
    setLoading(true);
    setErrorBanner('');
    try {
      const result = await api.upgradeEmail({ email: values.email, upgradeToken });
      setPendingEmail(result.email);
      switchMode('verify_pending');
    } catch (e: any) {
      setErrorBanner(e?.message || '提交失败');
    } finally {
      setLoading(false);
    }
  };

  const handleResetFinish = async (values: { password: string; confirm: string }) => {
    setLoading(true);
    setErrorBanner('');
    try {
      const result = await api.resetPassword({
        token: initialTokenInUrl.token,
        password: values.password
      });
      window.history.replaceState({}, '', '/');
      await onAuthenticated({ token: result.token, user: result.user });
    } catch (e: any) {
      setErrorBanner(e?.message || '重置失败，请重新申请');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!pendingEmail) return;
    setLoading(true);
    try {
      await api.resendVerification(pendingEmail);
      message.success('验证邮件已重新发送，请查收');
    } catch (e: any) {
      message.error(e?.message || '重发失败');
    } finally {
      setLoading(false);
    }
  };

  const title = (() => {
    switch (mode) {
      case 'register': return '创建账号';
      case 'forgot': return '找回密码';
      case 'verify_pending': return '请验证你的邮箱';
      case 'upgrade_required': return '完善账户邮箱';
      case 'reset_sent': return '重置邮件已发送';
      case 'reset_form': return '设置新密码';
      case 'verifying_url': return '正在验证邮箱…';
      default: return '欢迎回来';
    }
  })();

  const subtitle = (() => {
    switch (mode) {
      case 'register': return '注册后会向你的邮箱发送一封验证邮件。';
      case 'forgot': return '我们会向你的注册邮箱发送一次性重置链接（15 分钟内有效）。';
      case 'verify_pending': return `验证邮件已发送到 ${pendingEmail}，请前往邮箱完成验证（15 分钟内有效）。`;
      case 'upgrade_required': return '为了提升账户安全，请绑定邮箱并完成验证。';
      case 'reset_sent': return `若 ${pendingEmail} 已注册，重置链接将很快送达；如长时间未收到请检查垃圾邮件。`;
      case 'reset_form': return '请设置新密码，提交后将自动登录。';
      case 'verifying_url': return '请稍候…';
      default: return '使用统一的轨道设计工作区，继续之前的地图编辑与导出流程。';
    }
  })();

  return (
    <div className={`auth-card auth-card--${mode}`}>
      <div className="auth-card__inner">
        <section className="auth-card__info" aria-hidden="true">
          <img className="auth-hero-image" src={authHeroImage} alt="" />
        </section>

        <section className="auth-card__form">
          <div className="auth-form-shell">
            <Title className="auth-form-title">{title}</Title>
            <Text className="auth-form-subtitle">{subtitle}</Text>

            {(mode === 'login' || mode === 'register') && (
              <div className="auth-switcher">
                <button
                  type="button"
                  className={`auth-switcher__btn ${mode === 'login' ? 'is-active' : ''}`}
                  onClick={() => switchMode('login')}
                >登录</button>
                <button
                  type="button"
                  className={`auth-switcher__btn ${mode === 'register' ? 'is-active' : ''}`}
                  onClick={() => switchMode('register')}
                >注册</button>
              </div>
            )}

            {errorBanner ? (
              <Alert
                type="error"
                showIcon
                message={errorBanner}
                style={{ marginBottom: 12 }}
                closable
                onClose={() => setErrorBanner('')}
              />
            ) : null}

            {mode === 'login' && (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleLoginFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="account"
                  label="邮箱"
                  // 老手机号账号也能从这里登入（后端按是否含 @ 自动路由），所以输入规则放宽，
                  // 真正的格式校验留给服务端 + 错误提示。
                  rules={[{ required: true, message: '请输入邮箱或已绑定的手机号' }]}
                >
                  <Input
                    prefix={<MailOutlined />}
                    placeholder="email@example.com"
                    size="large"
                    autoComplete="username"
                    maxLength={254}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="请输入登录密码"
                    size="large"
                    autoComplete="current-password"
                  />
                </Form.Item>
                <div style={{ textAlign: 'right', marginTop: -6, marginBottom: 12 }}>
                  <Button type="link" size="small" onClick={() => switchMode('forgot')} style={{ paddingRight: 0 }}>
                    忘记密码？
                  </Button>
                </div>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  登录并进入工作台
                  <ArrowRightOutlined />
                </Button>
              </Form>
            )}

            {mode === 'register' && (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleRegisterFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="username"
                  label="用户名"
                  rules={[
                    { required: true, message: '请输入用户名' },
                    { min: 2, message: '至少 2 个字符' }
                  ]}
                >
                  <Input
                    prefix={<UserOutlined />}
                    placeholder="给自己取一个清晰的名字"
                    size="large"
                    maxLength={32}
                  />
                </Form.Item>
                <Form.Item
                  name="email"
                  label="邮箱"
                  rules={[
                    { required: true, message: '请输入邮箱' },
                    { type: 'email', message: '邮箱格式无效' }
                  ]}
                >
                  <Input
                    prefix={<MailOutlined />}
                    placeholder="用于登录、验证、找回密码"
                    size="large"
                    autoComplete="email"
                    maxLength={254}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={[
                    { required: true, message: '请输入密码' },
                    { min: 6, message: '密码长度至少 6 位' }
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="设置登录密码"
                    size="large"
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  label="确认密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error('两次输入的密码不一致'));
                      }
                    })
                  ]}
                >
                  <Input.Password
                    prefix={<LockOutlined />}
                    placeholder="再次输入密码"
                    size="large"
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  注册并发送验证邮件
                  <ArrowRightOutlined />
                </Button>
              </Form>
            )}

            {mode === 'forgot' && (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleForgotFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="email"
                  label="注册邮箱"
                  rules={[
                    { required: true, message: '请输入邮箱' },
                    { type: 'email', message: '邮箱格式无效' }
                  ]}
                >
                  <Input prefix={<MailOutlined />} placeholder="email@example.com" size="large" maxLength={254} />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  发送重置链接
                </Button>
                <Button type="link" block style={{ marginTop: 12 }} onClick={() => switchMode('login')}>
                  返回登录
                </Button>
              </Form>
            )}

            {mode === 'verify_pending' && (
              <div className="auth-form" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  没收到？检查垃圾邮件；或点击重发。
                </Paragraph>
                <Button
                  icon={<ReloadOutlined />}
                  block
                  size="large"
                  loading={loading}
                  onClick={handleResend}
                >
                  重新发送验证邮件
                </Button>
                <Button type="link" block onClick={() => switchMode('login')}>
                  返回登录
                </Button>
              </div>
            )}

            {mode === 'upgrade_required' && (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleUpgradeFinish}
                autoComplete="off"
                requiredMark={false}
              >
                {hint ? (
                  <Alert type="info" showIcon message={hint} style={{ marginBottom: 12 }} />
                ) : null}
                <Form.Item
                  name="email"
                  label="邮箱"
                  rules={[
                    { required: true, message: '请输入邮箱' },
                    { type: 'email', message: '邮箱格式无效' }
                  ]}
                >
                  <Input prefix={<MailOutlined />} placeholder="email@example.com" size="large" maxLength={254} />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  绑定邮箱并发送验证邮件
                </Button>
                <Button type="link" block style={{ marginTop: 12 }} onClick={() => switchMode('login')}>
                  返回登录
                </Button>
              </Form>
            )}

            {mode === 'reset_sent' && (
              <div className="auth-form" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Button type="primary" block size="large" onClick={() => switchMode('login')}>
                  返回登录
                </Button>
              </div>
            )}

            {mode === 'reset_form' && (
              <Form
                className="auth-form"
                layout="vertical"
                onFinish={handleResetFinish}
                autoComplete="off"
                requiredMark={false}
              >
                <Form.Item
                  name="password"
                  label="新密码"
                  rules={[
                    { required: true, message: '请输入新密码' },
                    { min: 6, message: '密码长度至少 6 位' }
                  ]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="设置新密码" size="large" autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  name="confirm"
                  label="确认密码"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve();
                        }
                        return Promise.reject(new Error('两次输入的密码不一致'));
                      }
                    })
                  ]}
                >
                  <Input.Password prefix={<LockOutlined />} placeholder="再次输入新密码" size="large" autoComplete="new-password" />
                </Form.Item>
                <Button className="auth-submit-btn" type="primary" htmlType="submit" block size="large" loading={loading}>
                  设置新密码并登录
                </Button>
              </Form>
            )}

            {mode === 'verifying_url' && (
              <Paragraph type="secondary" style={{ marginTop: 12 }}>
                正在为你登录…
              </Paragraph>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default AuthPanel;
