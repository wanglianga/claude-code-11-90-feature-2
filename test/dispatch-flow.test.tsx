// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProviders } from '../src/App';
import { ensureSeeded, setServerNetworkOnline } from '../src/mock/server';

afterEach(() => cleanup());

beforeEach(() => {
  sessionStorage.clear();
  window.location.hash = '';
  window.history.pushState({}, '', '/');
  Element.prototype.scrollIntoView = () => {};
  setServerNetworkOnline(true);
});

describe('主管应用排程 → 个案同步（浏览器全链路）', () => {
  it('以主管身份应用“保持人员”方案后，B 的预约与家庭准备改到 10:30，并出现待发通知', async () => {
    await ensureSeeded(true);
    render(<AppProviders />);
    fireEvent.click(await screen.findByRole('button', { name: '进入工作台' }));
    await waitFor(() => expect(screen.getAllByText(/陈桂兰/).length).toBeGreaterThan(0), { timeout: 6000 });
    fireEvent.click(screen.getAllByRole('link', { name: /上门日程编排/ })[0]);
    await screen.findByRole('heading', { name: /跨个案上门日程编排/ });
    fireEvent.click(screen.getByRole('button', { name: /一键切换为主管王敏/ }));
    await waitFor(() => expect(screen.getByText(/王敏（服务主管）/)).toBeTruthy(), { timeout: 4000 });

    const applyBtn = await screen.findByRole('button', { name: /应用「保持人员」方案/ }) as HTMLButtonElement;
    await waitFor(() => expect(applyBtn.disabled).toBe(false));
    fireEvent.click(applyBtn);

    // 出现“已应用”卡片
    await waitFor(() => expect(screen.getByText(/已应用：保持人员方案/)).toBeTruthy(), { timeout: 8000 });

    // 进入柏文山个案的「准备与通知」
    window.location.hash = '#/case/case-bai';
    await waitFor(() => expect(screen.getByRole('heading', { name: /柏文山/ })).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByRole('tab', { name: '准备与通知' }));
    // 家庭准备事项已同步到 10:30
    await waitFor(() => {
      expect(screen.getAllByText(/10:30/).length).toBeGreaterThan(0);
    });
    // 待发通知（页头徽标 + 通知条目都含“待发出”）
    expect(screen.getAllByText(/待发出/).length).toBeGreaterThan(0);
    const notice = screen.getByText(/东区·柏（B）：到访时间/);
    expect(notice.textContent).toMatch(/10:30/);
    // 预约管理里确认预约时间已到 10:30
    fireEvent.click(screen.getByRole('tab', { name: '预约管理' }));
    await waitFor(() => expect(screen.getByText(/10:30/)).toBeTruthy());
  }, 40000);

  it('以社工身份尝试应用时按钮禁用（不产生写入）', async () => {
    await ensureSeeded(true);
    render(<AppProviders />);
    fireEvent.click(await screen.findByRole('button', { name: '进入工作台' }));
    await waitFor(() => expect(screen.getAllByText(/陈桂兰/).length).toBeGreaterThan(0), { timeout: 6000 });
    fireEvent.click(screen.getAllByRole('link', { name: /上门日程编排/ })[0]);
    await screen.findByRole('heading', { name: /跨个案上门日程编排/ });
    const applyBtn = (await screen.findByRole('button', { name: /应用「保持人员」方案/ })) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  }, 30000);
});
