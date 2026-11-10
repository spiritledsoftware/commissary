// Command claudeprofile emits golden fixtures for the TypeScript Claude device profile stabiliser
// (packages/models/src/executor/claude/device-profile.ts): sequences of requests resolved by the real
// helps.ResolveClaudeDeviceProfile (local cache mode). Run from the repository root:
//
//	go run ./tools/fixturegen/claudeprofile
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type step struct {
	AuthID  string            `json:"authId"`
	APIKey  string            `json:"apiKey"`
	Headers map[string]string `json:"headers"`
	Want    profile           `json:"want"`
}

type profile struct {
	UserAgent      string `json:"userAgent"`
	PackageVersion string `json:"packageVersion"`
	RuntimeVersion string `json:"runtimeVersion"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
}

type scenario struct {
	Name     string                      `json:"name"`
	Defaults config.ClaudeHeaderDefaults `json:"defaults"`
	Steps    []step                      `json:"steps"`
}

func native(version, entrypoint string) string {
	return fmt.Sprintf("claude-cli/%s (external, %s)", version, entrypoint)
}

func h(userAgent string, extra ...string) map[string]string {
	headers := map[string]string{"User-Agent": userAgent}
	for index := 0; index+1 < len(extra); index += 2 {
		headers[extra[index]] = extra[index+1]
	}
	return headers
}

func main() {
	out := flag.String("out", "packages/models/test/fixtures/claude-profile.json", "output file")
	flag.Parse()
	stable := true
	base := config.ClaudeHeaderDefaults{StabilizeDeviceProfile: &stable}
	custom := config.ClaudeHeaderDefaults{
		StabilizeDeviceProfile: &stable,
		UserAgent:              "claude-cli/2.2.0 (external, cli)",
		PackageVersion:         "0.200.0",
		RuntimeVersion:         "v30.0.1",
		OS:                     "Linux",
		Arch:                   "x64",
	}
	platform := []string{"X-Stainless-Os", "Windows", "X-Stainless-Arch", "x86"}
	scenarios := []scenario{
		{Name: "baseline, pinned platform and reuse", Defaults: base, Steps: []step{
			{AuthID: "a1", Headers: nil},
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"), platform...)},
			{AuthID: "a1", Headers: nil},
			{AuthID: "a2", Headers: nil},
		}},
		{Name: "entrypoints have their own scope", Defaults: base, Steps: []step{
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"))},
			{AuthID: "a1", Headers: h(native("2.1.321", "sdk-cli"))},
			{AuthID: "a1", Headers: nil},
			{AuthID: "a1", Headers: h(native("2.1.321", "claude-vscode"))},
			{AuthID: "a1", Headers: h(native("2.1.321", "claude-desktop"))},
			{AuthID: "a1", Headers: h("claude-cli/2.1.321 (external, sdk-cli, agent-sdk/0.1.5)")},
			{AuthID: "a1", Headers: h(native("2.1.321", "SDK-CLI"))},
		}},
		{Name: "candidates must match the baseline tuple", Defaults: base, Steps: []step{
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"))},
			{AuthID: "a1", Headers: h(native("2.1.322", "cli"))},
			{AuthID: "a1", Headers: h(native("2.2.0", "cli"))},
			{AuthID: "a1", Headers: h(native("2.1.320", "cli"))},
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"), "X-Stainless-Package-Version", "0.99.0")},
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"), "X-Stainless-Runtime-Version", "v1.0.0")},
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"), "X-Stainless-Package-Version", "bogus", "X-Stainless-Runtime-Version", "node")},
			{AuthID: "a1", Headers: h("curl/8.0")},
			{AuthID: "a1", Headers: h("claude-cli/2.1.321")},
			{AuthID: "a1", Headers: h("claude-cli/2.1.321 (external, cli) extra")},
		}},
		{Name: "api key and global scopes", Defaults: base, Steps: []step{
			{APIKey: "sk-one", Headers: h(native("2.1.321", "sdk-cli"))},
			{APIKey: "sk-one", Headers: h(native("2.1.321", "cli"))},
			{APIKey: "sk-one", Headers: nil},
			{APIKey: "sk-two", Headers: nil},
			{Headers: h(native("2.1.321", "cli"))},
			{Headers: nil},
			{AuthID: "  ", APIKey: " sk-one ", Headers: nil},
		}},
		{Name: "configured baseline", Defaults: custom, Steps: []step{
			{AuthID: "a1", Headers: nil},
			{AuthID: "a1", Headers: h(native("2.1.321", "cli"))},
			{AuthID: "a1", Headers: h(native("2.2.0", "cli"), "X-Stainless-Package-Version", "0.200.0", "X-Stainless-Runtime-Version", "v30.0.1", "X-Stainless-Os", "MacOS")},
			{AuthID: "a1", Headers: nil},
		}},
	}
	for index := range scenarios {
		sc := &scenarios[index]
		helps.ResetClaudeDeviceProfileCache()
		cfg := &config.Config{ClaudeHeaderDefaults: sc.Defaults}
		for stepIndex := range sc.Steps {
			st := &sc.Steps[stepIndex]
			var auth *cliproxyauth.Auth
			if st.AuthID != "" {
				auth = &cliproxyauth.Auth{ID: st.AuthID}
			}
			headers := http.Header{}
			for key, value := range st.Headers {
				headers.Set(key, value)
			}
			resolved := helps.ResolveClaudeDeviceProfile(auth, st.APIKey, headers, cfg)
			st.Want = profile{resolved.UserAgent, resolved.PackageVersion, resolved.RuntimeVersion, resolved.OS, resolved.Arch}
		}
	}
	encoded, err := json.MarshalIndent(scenarios, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s\n", *out)
}
