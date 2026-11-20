import { describe, expect, it } from "vitest";

import { fdRedirectionFlags } from "./shellRedirects";

describe("fdRedirectionFlags", () => {
  it("digit_directly_before_operator_is_an_fd", () => {
    expect(fdRedirectionFlags("ls 2>&1")).toEqual([true]);
    expect(fdRedirectionFlags("ls 10>&1")).toEqual([true]);
    expect(fdRedirectionFlags("ls 2>a 3<b")).toEqual([true, true]);
  });

  it("detached_or_embedded_digits_are_arguments", () => {
    expect(fdRedirectionFlags("ls 2 >&1")).toEqual([false]);
    expect(fdRedirectionFlags("ls a2>f")).toEqual([false]);
    expect(fdRedirectionFlags(String.raw`ls \2>f`)).toEqual([false]);
  });

  it("quoted_digits_are_arguments", () => {
    expect(fdRedirectionFlags("ls '2'>f")).toEqual([false]);
    expect(fdRedirectionFlags('ls "2">f')).toEqual([false]);
  });

  it("ampersand_redirect_never_has_an_fd_prefix", () => {
    expect(fdRedirectionFlags("ls &>f")).toEqual([false]);
    expect(fdRedirectionFlags("ls 2&>f")).toEqual([false]);
  });

  it("double_operators_count_once", () => {
    expect(fdRedirectionFlags("ls >>f")).toEqual([false]);
    expect(fdRedirectionFlags("ls 2>>f")).toEqual([true]);
    expect(fdRedirectionFlags("ls >|f")).toEqual([false]);
    expect(fdRedirectionFlags("ls <>f")).toEqual([false]);
  });

  it("quoted_operators_are_not_redirections", () => {
    expect(fdRedirectionFlags('echo "x>y" 2>f')).toEqual([true]);
    expect(fdRedirectionFlags("echo 'a>b'")).toEqual([]);
    expect(fdRedirectionFlags(String.raw`echo a\>b 2>&1`)).toEqual([true]);
  });

  it("unterminated_quote_is_untrusted", () => {
    expect(fdRedirectionFlags("echo 'unterminated")).toBeNull();
    expect(fdRedirectionFlags('echo "unterminated 2>&1')).toBeNull();
  });

  it("command_without_redirection_has_no_flags", () => {
    expect(fdRedirectionFlags("ls -la && echo hi | wc")).toEqual([]);
  });
});
