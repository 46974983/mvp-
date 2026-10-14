/**
 * Vitest 全局前置
 * ----------------------------------------------------------------------------
 * 每个用例前清干净存储和 id 计数器。不清的话，用例会按执行顺序互相影响 ——
 * 那种「单跑通过、一起跑就红」的测试，比没有测试更浪费时间。
 */

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { __resetIdCounter } from '@/lib/id';

beforeEach(() => {
  window.localStorage.clear();
  __resetIdCounter();
});

afterEach(() => {
  cleanup();
});
