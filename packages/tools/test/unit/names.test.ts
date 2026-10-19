// Tool and toolkit names (ADR 0037): `[a-z0-9_]` only, `<toolkit>_<tool>`, at most 46 characters, a longer one cut and
// ended with a four-character hash of the whole name; a toolkit's default name is its source's host-derived slug.
import { describe, expect, it } from "vitest";
import {
  defaultToolkitName,
  fullToolName,
  isToolkitName,
  sanitizeName,
} from "../../src/toolkits/names.ts";

describe("sanitizeName", () => {
  it("lowercases and replaces every character outside [a-z0-9_] with an underscore", () => {
    expect(sanitizeName("Create-Issue")).toBe("create_issue");
    expect(sanitizeName("repos.get_content")).toBe("repos_get_content");
    expect(sanitizeName("send email (v2)")).toBe("send_email__v2_");
    expect(sanitizeName("café")).toBe("caf_");
    expect(sanitizeName("already_fine_42")).toBe("already_fine_42");
  });
});

describe("fullToolName", () => {
  it("joins the toolkit's name and the sanitised tool name with one underscore", () => {
    expect(fullToolName("github", "Create.Issue")).toEqual({
      name: "github_create_issue",
      shortened: false,
    });
  });

  it("keeps a name of exactly 46 characters", () => {
    const tool = "a".repeat(46 - "github_".length);

    expect(fullToolName("github", tool)).toEqual({ name: `github_${tool}`, shortened: false });
  });

  it("cuts a longer name to 46 characters ending in a hash of the whole name, and flags it", () => {
    // sha256("stripe_retrieve_a_very_long_customer_payment_method_configuration") starts with a318.
    expect(
      fullToolName("stripe", "retrieve_a_very_long_customer_payment_method_configuration"),
    ).toEqual({
      name: "stripe_retrieve_a_very_long_customer_paym_a318",
      shortened: true,
    });
  });

  it("gives two long names that share their first 41 characters different full names", () => {
    const first = fullToolName(
      "stripe",
      "retrieve_a_very_long_customer_payment_method_configuration",
    );

    const second = fullToolName(
      "stripe",
      "retrieve_a_very_long_customer_payment_intent_configuration",
    );

    expect(first.name).toHaveLength(46);
    expect(second.name).toHaveLength(46);
    expect(first.name).not.toBe(second.name);
  });
});

describe("toolkit names", () => {
  it("accepts lowercase words joined by single underscores, up to 32 characters", () => {
    expect(isToolkitName("github")).toBe(true);
    expect(isToolkitName("github_rest")).toBe(true);
    expect(isToolkitName("x2")).toBe(true);
    expect(isToolkitName("a".repeat(32))).toBe(true);
  });

  it("refuses anything else", () => {
    for (const name of ["", "GitHub", "git-hub", "_github", "github_", "git__hub", "a".repeat(33)])
      expect(isToolkitName(name)).toBe(false);
  });

  it("defaults to the slug of the source's host", () => {
    expect(defaultToolkitName(new URL("https://mcp.linear.app/mcp"))).toBe("linear");
    expect(defaultToolkitName(new URL("https://api.githubcopilot.com/mcp/"))).toBe("githubcopilot");
    expect(defaultToolkitName(new URL("https://mcp.example.co.uk/x"))).toBe("example");
    expect(defaultToolkitName(new URL("https://tools.my-server.dev/mcp"))).toBe("my_server");
    expect(defaultToolkitName(new URL("http://localhost:8787/mcp"))).toBe("localhost");
  });
});
