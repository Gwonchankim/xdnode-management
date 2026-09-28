"use client";

import { useEffect, useRef, useState } from "react";

type WonInputProps = {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  name?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  /** 방금 화면에 나타난 입력칸(예: 표의 금액을 눌러 수기 입력으로 바꾼 직후)에 바로 커서를 둔다. 없으면 사용자가 한 번 더 눌러야 한다. */
  focusOnEdit?: boolean;
};

function normalizeWon(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(Number(value))) : 0;
}

export default function WonInput({
  value,
  defaultValue,
  onValueChange,
  name,
  id,
  className,
  ariaLabel,
  disabled,
  required,
  focusOnEdit,
}: WonInputProps) {
  const controlled = value !== undefined;
  const [draft, setDraft] = useState(() => normalizeWon(defaultValue));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusOnEdit) inputRef.current?.focus(); }, [focusOnEdit]);
  // 포커스가 들어와 표시가 '157,808원' → '157808' 로 바뀐 뒤에 전체 선택한다. onFocus 안에서 바로 고르면
  // 값이 바뀌는 재렌더가 선택을 풀어 버려, 자동 포커스로 열린 칸에서는 타이핑이 기존 숫자 뒤에 붙었다.
  useEffect(() => { if (focused) inputRef.current?.select(); }, [focused]);
  const amount = controlled ? normalizeWon(value) : draft;
  const display = focused ? (amount ? String(amount) : "") : `${amount.toLocaleString("ko-KR")}원`;

  return <>
    <input
      ref={inputRef}
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className={className}
      aria-label={ariaLabel}
      disabled={disabled}
      required={required}
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      // Enter 로 입력을 마치면 포커스를 빼서 표시 형식(원)으로 돌아간다.
      onKeyDown={(event) => { if (event.key === "Enter" || event.keyCode === 13) event.currentTarget.blur(); }}
      onChange={(event) => {
        const digits = event.target.value.replace(/[^0-9]/g, "");
        const next = normalizeWon(digits ? Number(digits) : 0);
        if (!controlled) setDraft(next);
        onValueChange?.(next);
      }}
    />
    {name && <input type="hidden" name={name} value={amount} />}
  </>;
}
