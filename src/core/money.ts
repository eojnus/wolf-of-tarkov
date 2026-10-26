/**
 * 货币基础工具 —— 只处理单位、范围与格式化，不含任何业务规则。
 *
 * 所有金额一律使用「分」为单位的整数，避免浮点误差。任何金额在进入业务
 * 之前都必须经过这里的安全整数与范围校验。
 */

import { BusinessError } from './errors';

export const CENTS_PER_YUAN = 100;

/** 单笔金额上限：100 亿元（分），远低于 Number.MAX_SAFE_INTEGER。 */
export const MAX_MONEY_CENTS = 1_000_000_000_000;

export function assertMoneyRange(amount: number, field = '金额'): void {
  if (!Number.isSafeInteger(amount)) {
    throw new BusinessError('INVALID_AMOUNT', `${field}必须是整数（分）`);
  }
  if (amount <= 0) {
    throw new BusinessError('INVALID_AMOUNT', `${field}必须大于 0`);
  }
  if (amount > MAX_MONEY_CENTS) {
    throw new BusinessError('AMOUNT_OUT_OF_RANGE', `${field}超出可处理范围`);
  }
}

/** 余额类数值（可为 0，但必须是非负安全整数）。 */
export function assertBalance(amount: number, field = '余额'): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new BusinessError('INVALID_BALANCE', `${field}必须是非负整数（分）`);
  }
  if (amount > MAX_MONEY_CENTS) {
    throw new BusinessError('BALANCE_OUT_OF_RANGE', `${field}超出可处理范围`);
  }
}

/** 安全相加，溢出即拒绝。 */
export function safeAddMoney(a: number, b: number, field = '金额'): number {
  const next = a + b;
  if (!Number.isSafeInteger(next) || next > MAX_MONEY_CENTS) {
    throw new BusinessError('AMOUNT_OVERFLOW', `${field}累加后超出可处理范围`);
  }
  return next;
}

/** 分 → "¥1,234.56"。 */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / CENTS_PER_YUAN);
  const fen = abs % CENTS_PER_YUAN;
  return `${sign}¥${yuan.toLocaleString('en-US')}.${String(fen).padStart(2, '0')}`;
}

/** 分 → "¥1,235"（省略零角分，用于空间紧凑处）。 */
export function formatMoneyCompact(cents: number): string {
  if (cents % CENTS_PER_YUAN === 0) {
    return `¥${(cents / CENTS_PER_YUAN).toLocaleString('en-US')}`;
  }
  return formatMoney(cents);
}

/**
 * 解析用户输入的「元」为「分」。仅接受非负数字，最多两位小数。
 * 空串、负数、超过两位小数、非数字均返回 null（由调用方提示）。
 */
export function parseYuanInput(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '').replace(/^¥/, '');
  if (text.length === 0) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [wholePart = '0', fractionPart = ''] = text.split('.');
  const whole = Number(wholePart);
  const fraction = Number(fractionPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
  const cents = whole * CENTS_PER_YUAN + fraction;
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) return null;
  return cents;
}
