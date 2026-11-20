import { expect, it } from "vitest";

import { createAccountReservations } from "./accountReservations";

it("keeps an account reserved until every launch releases it", () => {
  const reservations = createAccountReservations();
  const first = reservations.reserve("acc-a");
  const second = reservations.reserve("acc-a");

  first();

  expect(reservations.has("acc-a")).toBe(true);
  second();
  expect(reservations.has("acc-a")).toBe(false);
});

it("releasing the same reservation twice frees only its own count", () => {
  const reservations = createAccountReservations();
  const first = reservations.reserve("acc-a");
  reservations.reserve("acc-a");

  first();
  first();

  expect(reservations.has("acc-a")).toBe(true);
});

it("reservations of different accounts are independent", () => {
  const reservations = createAccountReservations();
  const release = reservations.reserve("acc-a");
  reservations.reserve("acc-b");

  release();

  expect(reservations.has("acc-a")).toBe(false);
  expect(reservations.has("acc-b")).toBe(true);
});
