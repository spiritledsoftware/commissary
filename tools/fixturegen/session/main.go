// Command session emits golden fixtures for the TypeScript session routing port (apps/app/src/session-routing):
// canonical turns and fingerprints, the derived content-hash identity, the message-hash fallback, identity helpers and
// scripted scenarios of the LCP conversation matcher. Everything is produced by the real sdk/cliproxy/session and
// sdk/cliproxy/auth code. Run from the repository root:
//
//	go run ./tools/fixturegen/session
package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/auth/vertex"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/session"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
)

type bodyCase struct {
	Name   string `json:"name"`
	Format string `json:"format"`
	Body   string `json:"body"`
}

type canonicalResult struct {
	bodyCase
	Roles        []string `json:"roles"`
	Fingerprints []string `json:"fingerprints"`
	MinPrefix    int      `json:"minPrefixLength"`
	Tail         []string `json:"tailFingerprints"`
	EnvDigest    string   `json:"envDigest"`
}

type deriveResult struct {
	bodyCase
	CallerScope string            `json:"callerScope"`
	Headers     map[string]string `json:"headers,omitempty"`
	Derived     string            `json:"derived"`
	MessageHash string            `json:"messageHash"`
}

type step struct {
	Op     string `json:"op"`
	Format string `json:"format,omitempty"`
	Body   string `json:"body,omitempty"`
	Auth   string `json:"auth,omitempty"`
	Ns     string `json:"namespace,omitempty"`
	Ms     int64  `json:"ms,omitempty"`
	// Generation of a remove: index of an earlier step whose accessNumber is the maxGeneration (-1 = none).
	GenerationOf int `json:"generationOf"`
}

type stepResult struct {
	OK              bool     `json:"ok"`
	AuthID          string   `json:"authId,omitempty"`
	SessionID       string   `json:"sessionId,omitempty"`
	ParentSessionID string   `json:"parentSessionId,omitempty"`
	PrefixLength    int      `json:"prefixLength,omitempty"`
	IsFork          bool     `json:"isFork,omitempty"`
	IsCompaction    bool     `json:"isCompaction,omitempty"`
	NodeKind        string   `json:"nodeKind,omitempty"`
	AccessNumber    uint64   `json:"accessNumber,omitempty"`
	Groups          []string `json:"auths,omitempty"`
}

type matcherConfig struct {
	MaxGroups   int `json:"maxGroups,omitempty"`
	MaxPrefixes int `json:"maxPrefixes,omitempty"`
	MaxTurns    int `json:"maxTurns,omitempty"`
}

type scenario struct {
	Name    string        `json:"name"`
	Config  matcherConfig `json:"config"`
	Steps   []step        `json:"steps"`
	Results []stepResult  `json:"results"`
}

type identityCase struct {
	Input string `json:"input"`
	Bound string `json:"bound"`
	UUID  string `json:"uuid"`
}

func jsonString(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func format(name string) sdktranslator.Format { return sdktranslator.Format(name) }

func msgs(pairs ...string) string {
	var out []string
	for index := 0; index+1 < len(pairs); index += 2 {
		out = append(out, jsonString(map[string]string{"role": pairs[index], "content": pairs[index+1]}))
	}
	return `{"model":"gpt-5","messages":[` + strings.Join(out, ",") + `]}`
}

func bodyCases() []bodyCase {
	long := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 600)
	bigInput := map[string]any{"items": make([]string, 0)}
	items := make([]string, 0, 900)
	for index := 0; index < 900; index++ {
		items = append(items, fmt.Sprintf("item-%04d-plain", index))
	}
	bigInput["items"] = items
	var manyParts []string
	for index := 0; index < 300; index++ {
		manyParts = append(manyParts, fmt.Sprintf(`{"type":"text","text":"part %d"}`, index))
	}
	cases := []bodyCase{
		{"openai simple", "openai", msgs("system", "Be helpful", "user", "hello", "assistant", "hi")},
		{"openai crlf and thinking", "openai", msgs("system", "Rules\r\nline two\rline three", "user", "<think>secret</think>  hello \r\n world ")},
		{"openai dynamic system", "openai", msgs("developer", "Today is 2026-03-04T05:06:07Z and id 123e4567-e89b-42d3-a456-426614174000 end", "user", "q")},
		{"openai tool calls", "openai", `{"messages":[{"role":"user","content":"weather?"},{"role":"assistant","content":null,"tool_calls":[{"id":"b","type":"function","function":{"name":"w","arguments":"{\"city\":\"Paris\"}"}},{"id":"a","type":"function","function":{"name":"a","arguments":"{}"}}]},{"role":"tool","content":"sunny","tool_call_id":"b"}]}`},
		{"openai multimodal", "openai", `{"messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},{"type":"input_audio","input_audio":{"data":"zz","format":"wav"}}]}]}`},
		{"openai reasoning dropped", "openai", `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"answer"}]},{"role":"user","content":"k"}]}`},
		{"openai message without content", "openai", `{"messages":[{"role":"user","name":"bob","extra":{"b":1,"a":[1,2,{"z":true,"y":null}]}},"loose string",{"role":"USER","content":" Trim \u00a0 "}]}`},
		{"openai special chars", "openai", `{"messages":[{"role":"user","content":[{"type":"mystery","a":"<tag> & \u2028 \u0001 \"quoted\" \\ back","n":[1.5,-2,1e21,1e-7,12345678901234567890],"b":{"z":1,"a":2}}]}]}`},
		{"openai unicode", "openai", msgs("user", "日本語のテキスト 🚀 emoji", "assistant", "ünïcödé")},
		{"openai empty", "openai", `{"messages":[]}`},
		{"openai system only", "openai", msgs("system", "only system")},
		{"openai long text", "openai", msgs("system", long, "user", long, "assistant", "ok")},
		{"openai long json", "openai", `{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":` + jsonString(bigInput) + `}]}]}`},
		{"openai many parts", "openai", `{"messages":[{"role":"user","content":[` + strings.Join(manyParts, ",") + `]}]}`},
		{"claude system array", "claude", `{"system":[{"type":"text","text":"Be helpful","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]},{"role":"assistant","content":"hi"}]}`},
		{"claude tool blocks", "claude", `{"system":"sys","messages":[{"role":"user","content":"go"},{"role":"assistant","content":[{"type":"text","text":"calling"},{"type":"tool_use","id":"tu_2","name":"b","input":{"x":1}},{"type":"tool_use","id":"tu_1","name":"a","input":{"y":2}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"done"}]}]}`},
		{"claude image source", "claude", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]}`},
		{"responses basic", "openai-response", `{"instructions":"Be helpful","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`},
		{"responses string input", "openai-response", `{"instructions":"sys","input":"plain question"}`},
		{"responses function items", "codex", `{"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run"}]},{"type":"reasoning","summary":[]},{"type":"function_call","call_id":"c1","name":"sh","arguments":"{\"cmd\":\"ls\"}"},{"type":"function_call_output","call_id":"c1","output":"file"},{"type":"compaction","encrypted_content":"abc"},{"type":"mystery","x":1}]}`},
		{"gemini basic", "gemini", `{"systemInstruction":{"parts":[{"text":"Be helpful"}]},"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"hi"}]}]}`},
		{"gemini function parts", "gemini", `{"contents":[{"role":"user","parts":[{"text":"go"}]},{"role":"model","parts":[{"functionCall":{"name":"b","args":{"q":1}}},{"functionCall":{"name":"a","args":{}}}]},{"role":"user","parts":[{"functionResponse":{"name":"a","response":{"ok":true}}},{"inlineData":{"mimeType":"image/png","data":"AA"}}]}]}`},
		{"gemini cached content nested request", "antigravity", `{"request":{"cachedContent":"cachedContents/abc","system_instruction":{"parts":[{"text":"s"}]},"contents":[{"role":"user","parts":[{"text":"hello"}]}]}}`},
		{"gemini thought part", "gemini", `{"contents":[{"role":"model","parts":[{"text":"hmm","thought":true},{"text":"answer"}]},{"role":"user","parts":[{"text":"k"}]}]}`},
		{"interactions", "interactions", `{"system_instruction":"Be helpful","input":[{"type":"user_input","content":[{"type":"text","text":"hello"}]},{"type":"model_output","content":[{"type":"text","text":"hi"}]},{"type":"function_call","name":"f","arguments":{}}]}`},
		{"interactions steps", "interactions", `{"input":{"role":"user","steps":[{"type":"user_input","content":"one"},{"type":"model_output","content":"two"}]}}`},
		{"interactions string", "interactions", `{"input":"just text"}`},
	}
	return cases
}

func messageHash(payload string) string {
	return cliproxyauth.ExtractSessionID(http.Header{}, []byte(payload), nil)
}

func deriveCases() []deriveResult {
	var out []deriveResult
	scopes := []string{"scope-a", ""}
	for _, c := range bodyCases() {
		for _, scope := range scopes {
			out = append(out, deriveFor(c, scope, nil))
		}
	}
	extra := []bodyCase{
		{"explicit session body", "openai", `{"session_id":"abc","messages":[{"role":"user","content":"hello"}]}`},
		{"explicit prompt cache key", "openai-response", `{"prompt_cache_key":"k","input":"hi"}`},
		{"explicit claude user id", "claude", `{"metadata":{"user_id":"{\"session_id\":\"s1\"}"},"messages":[{"role":"user","content":"hello"}]}`},
		{"explicit conversation object", "openai-response", `{"conversation":{"id":"c1"},"input":"hi"}`},
		{"explicit chat id", "openai", `{"chat_id":"c9","messages":[{"role":"user","content":"hello"}]}`},
		{"claude cache control stripped", "claude", `{"messages":[{"role":"user","content":[{"type":"text","text":"a"},{"type":"mystery","cache_control":{"type":"ephemeral"},"Cache_Control":{"x":1},"k":"<v>"}]}]}`},
		{"gemini nested", "gemini", `{"request":{"cachedContent":"cc/1","contents":[{"role":"user","parts":[{"text":"hello"},{"inlineData":{"mimeType":"image/png","data":"AA"}},{"fileData":{"fileUri":"gs://b/o","mimeType":"video/mp4"}}]}]}}`},
		{"instructions truncated", "openai", msgs("system", strings.Repeat("é", 80), "user", "hello")},
		{"openai image url", "openai", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://x/y.png"}},{"type":"image_url","image_url":"http://x/z.png"}]}]}`},
		{"claude image source", "claude", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]}`},
	}
	for _, c := range extra {
		out = append(out, deriveFor(c, "scope-a", nil))
	}
	headerCases := []map[string]string{
		{"X-Session-ID": "abc"},
		{"X-Thread-Id": "t"},
		{"Thread-Id": "t"},
		{"X-Conversation-ID": "t"},
		{"Session-Id": "s"},
		{"X-Unrelated": "v"},
	}
	for _, headers := range headerCases {
		out = append(out, deriveFor(bodyCase{"headers", "openai", msgs("user", "hello")}, "scope-a", headers))
	}
	// Message hash cases: the short hash of a payload without an assistant turn is the fallback of the longer one.
	return out
}

func deriveFor(c bodyCase, scope string, headers map[string]string) deriveResult {
	result := deriveResult{bodyCase: c, CallerScope: scope, Headers: headers}
	httpHeaders := http.Header{}
	for key, value := range headers {
		httpHeaders.Set(key, value)
	}
	meta := map[string]any{}
	if scope != "" {
		meta[cliproxyexecutor.CallerScopeMetadataKey] = scope
	}
	_, opts := session.Enrich(cliproxyexecutor.Request{}, cliproxyexecutor.Options{
		Headers:         httpHeaders,
		OriginalRequest: []byte(c.Body),
		SourceFormat:    format(c.Format),
		Metadata:        meta,
	})
	result.Derived = session.DerivedID(opts.Metadata)
	result.MessageHash = messageHash(c.Body)
	return result
}

func canonicalCases() []canonicalResult {
	matcher := session.NewMerklePrefixMatcher(time.Hour)
	var out []canonicalResult
	for _, c := range bodyCases() {
		turns := session.ExtractCanonicalTurns(format(c.Format), []byte(c.Body))
		fingerprints, min, tail, env := matcher.PrepareExt(turns)
		roles := make([]string, 0, len(turns))
		for _, turn := range turns {
			roles = append(roles, turn.Role)
		}
		out = append(out, canonicalResult{bodyCase: c, Roles: roles, Fingerprints: fingerprints, MinPrefix: min, Tail: tail, EnvDigest: env})
	}
	return out
}

func identityCases() []identityCase {
	inputs := []string{
		"", "plain", "claude:123e4567-e89b-12d3-a456-426614174000", "123E4567-E89B-12D3-A456-426614174000",
		"derived:ctx:v1:abcdef", "lcp:v1:0123", "slot:", "thread:abc", "task:x:y", "prefix:123e4567-e89b-12d3-a456-426614174000",
		"codex:sess:agent:worker", strings.Repeat("a", 300), strings.Repeat("é", 200), strings.Repeat("日", 100),
		"  spaced  ",
	}
	out := make([]identityCase, 0, len(inputs))
	for _, input := range inputs {
		out = append(out, identityCase{Input: input, Bound: session.BoundSessionIdentity(input), UUID: session.NormalizeToCanonicalUUID(input)})
	}
	return out
}

type vertexCase struct {
	Name       string `json:"name"`
	PrivateKey string `json:"privateKey"`
	Normalized string `json:"normalized,omitempty"`
	Error      string `json:"error,omitempty"`
}

// vertexCases runs the real NormalizeServiceAccountMap over a fixed test key in several spellings.
// The key is a public throwaway (see the notice in the file); it stays fixed so the fixture is deterministic.
func vertexCases() []vertexCase {
	raw, err := os.ReadFile("tools/fixturegen/session/testdata/throwaway-rsa-2048.pem")
	if err != nil {
		panic(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		panic("throwaway-rsa-2048.pem: no PEM block")
	}
	// Re-encode the block so the notice before it stays out of the fixture.
	pkcs1 := string(pem.EncodeToMemory(block))
	parsed, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		panic(err)
	}
	pkcs8Der, err := x509.MarshalPKCS8PrivateKey(parsed)
	if err != nil {
		panic(err)
	}
	pkcs8 := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Der}))
	var _ *rsa.PrivateKey = parsed
	oneLine := strings.ReplaceAll(pkcs1, "\n", "")
	cases := []vertexCase{
		{Name: "pkcs1", PrivateKey: pkcs1},
		{Name: "pkcs8", PrivateKey: pkcs8},
		{Name: "crlf", PrivateKey: strings.ReplaceAll(pkcs1, "\n", "\r\n")},
		{Name: "ansi noise", PrivateKey: "\x1b[31m" + pkcs8 + "\x1b[0m"},
		{Name: "single line body", PrivateKey: strings.Replace(strings.Replace(oneLine, "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\n", 1), "-----END RSA PRIVATE KEY-----", "\n-----END RSA PRIVATE KEY-----", 1)},
		{Name: "padded", PrivateKey: "\n\n  " + pkcs1 + "  \n"},
		{Name: "no markers", PrivateKey: "not a key"},
		{Name: "empty payload", PrivateKey: "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"},
		{Name: "garbage rsa", PrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"},
	}
	for index := range cases {
		normalized, err := vertex.NormalizeServiceAccountMap(map[string]any{"private_key": cases[index].PrivateKey})
		if err != nil {
			cases[index].Error = err.Error()
			continue
		}
		cases[index].Normalized, _ = normalized["private_key"].(string)
	}
	return cases
}

type antigravitySession struct {
	Derived string `json:"derived"`
	ID      string `json:"id"`
}

func antigravitySessions() []antigravitySession {
	var out []antigravitySession
	for _, derived := range []string{"ctx:v1:abc", "ctx:v1:0123456789abcdef", ""} {
		meta := map[string]any{cliproxyexecutor.DerivedSessionIDMetadataKey: derived}
		out = append(out, antigravitySession{Derived: derived, ID: helps.DerivedAntigravitySessionID(meta)})
	}
	return out
}

func openaiBody(messages ...string) string { return msgs(messages...) }

func scenarios() []scenario {
	const ns = "lcp:v1::openai::gpt-5::scope"
	const ns2 = "lcp:v1::openai::gpt-5::other"
	b := func(op, body, auth string) step {
		return step{Op: op, Format: "openai", Body: body, Auth: auth, Ns: ns, GenerationOf: -1}
	}
	base := []string{"system", "Be helpful", "user", "u1", "assistant", "a1", "user", "u2"}
	conv := func(n int, extra ...string) string {
		return openaiBody(append(append([]string{}, base[:n]...), extra...)...)
	}
	compactionParent := openaiBody("system", "S", "user", "u1", "assistant", "a1", "user", "u2", "assistant", "a2", "user", "u3", "assistant", "a3", "user", "u4")
	compactionChild := openaiBody("system", "S", "user", "SUMMARY of earlier work", "user", "u3", "assistant", "a3", "user", "u4", "assistant", "a4", "user", "u5")

	var overflow []step
	for index := 0; index < 18; index++ {
		overflow = append(overflow, b("bind", openaiBody("system", "S", "user", fmt.Sprintf("first-%d", index), "assistant", "mid", "user", "tail-a", "assistant", "tail-b"), fmt.Sprintf("auth-%d", index)))
	}
	overflow = append(overflow, b("match", openaiBody("system", "S", "user", "SUMMARY", "assistant", "mid", "user", "tail-a", "assistant", "tail-b", "user", "more"), ""))

	var lru []step
	for index := 0; index < 4; index++ {
		lru = append(lru, b("bind", openaiBody("user", fmt.Sprintf("conversation %d", index), "assistant", "x"), fmt.Sprintf("auth-%d", index)))
	}
	for index := 0; index < 4; index++ {
		lru = append(lru, b("match", openaiBody("user", fmt.Sprintf("conversation %d", index), "assistant", "x", "user", "next"), ""))
	}

	return []scenario{
		{Name: "extension keeps session", Steps: []step{
			b("bind", conv(4), "auth-a"),
			b("match", conv(8), ""),
			b("touch", conv(8), "auth-a"),
			b("match", conv(8, "assistant", "a2", "user", "u3"), ""),
			b("bind", conv(8), "auth-a"),
		}},
		{Name: "fork on divergence", Steps: []step{
			b("bind", conv(8), "auth-a"),
			b("match", conv(6, "user", "different"), ""),
			b("bind", conv(6, "user", "different"), "auth-b"),
			b("match", conv(6, "user", "different", "assistant", "x"), ""),
			b("match", conv(8), ""),
		}},
		{Name: "expiry", Steps: []step{
			b("bind", conv(4), "auth-a"),
			{Op: "advance", Ms: 3599999, GenerationOf: -1},
			b("match", conv(4), ""),
			{Op: "advance", Ms: 3600001, GenerationOf: -1},
			b("match", conv(4), ""),
			b("touch", conv(4), "auth-a"),
			b("match", conv(4), ""),
		}},
		{Name: "system only and short sequences", Steps: []step{
			b("bind", openaiBody("system", "only"), "auth-a"),
			b("match", openaiBody("system", "only"), ""),
			b("bind", openaiBody("user", "solo"), "auth-a"),
			b("match", openaiBody("user", "solo"), ""),
			b("match", openaiBody("system", "different system", "user", "solo"), ""),
		}},
		{Name: "namespaces are isolated", Steps: []step{
			b("bind", conv(4), "auth-a"),
			{Op: "match", Format: "openai", Body: conv(4), Ns: ns2, GenerationOf: -1},
			{Op: "bind", Format: "openai", Body: conv(4), Ns: ns2, Auth: "auth-b", GenerationOf: -1},
			b("match", conv(4), ""),
		}},
		{Name: "touch by another credential and removal", Steps: []step{
			b("bind", conv(4), "auth-a"),
			b("touch", conv(4), "auth-b"),
			b("remove", conv(4), "auth-b"),
			b("remove", conv(4), "auth-a"),
			b("match", conv(4), ""),
			b("bind", conv(4), "auth-a"),
			b("match", conv(8), ""),
			{Op: "remove", Format: "openai", Body: conv(4), Ns: ns, Auth: "auth-a", GenerationOf: 6},
			b("match", conv(4), ""),
			{Op: "remove", Format: "openai", Body: conv(4), Ns: ns, Auth: "auth-a", GenerationOf: 0},
			b("match", conv(4), ""),
		}},
		{Name: "invalidate credential and lookup session", Steps: []step{
			b("bind", conv(4), "auth-a"),
			b("bind", openaiBody("user", "other conversation", "assistant", "x"), "auth-b"),
			{Op: "lookup", Format: "openai", Body: conv(4), Ns: ns, GenerationOf: -1},
			{Op: "invalidate", Auth: "auth-a", GenerationOf: -1},
			b("match", conv(4), ""),
			b("match", openaiBody("user", "other conversation", "assistant", "x"), ""),
		}},
		{Name: "compaction continuation", Steps: []step{
			b("bind", compactionParent, "auth-a"),
			b("match", compactionChild, ""),
			b("bind", compactionChild, "auth-b"),
			b("match", compactionChild, ""),
			b("match", openaiBody("system", "S", "user", "SUMMARY of earlier work", "user", "u3", "assistant", "a3", "user", "u4", "assistant", "a4", "user", "u5", "assistant", "a5", "user", "u6"), ""),
			b("match", openaiBody("system", "DIFFERENT", "user", "SUMMARY of earlier work", "user", "u3", "assistant", "a3", "user", "u4", "assistant", "a4", "user", "u5"), ""),
		}},
		{Name: "compaction ambiguity and tail overflow", Steps: overflow},
		{Name: "lru eviction", Config: matcherConfig{MaxGroups: 2}, Steps: lru},
		{Name: "prefix budget eviction", Config: matcherConfig{MaxTurns: 4, MaxPrefixes: 6}, Steps: []step{
			b("bind", openaiBody("user", "c1", "assistant", "x", "user", "y", "assistant", "z"), "auth-a"),
			b("bind", openaiBody("user", "c2", "assistant", "x", "user", "y", "assistant", "z"), "auth-a"),
			b("match", openaiBody("user", "c1", "assistant", "x", "user", "y", "assistant", "z"), ""),
			b("match", openaiBody("user", "c2", "assistant", "x", "user", "y", "assistant", "z", "user", "more"), ""),
		}},
		{Name: "protocols share nothing across formats but match within", Steps: []step{
			{Op: "bind", Format: "claude", Body: `{"system":"s","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]}`, Ns: ns, Auth: "auth-a", GenerationOf: -1},
			{Op: "match", Format: "claude", Body: `{"system":"s","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":"more"}]}`, Ns: ns, GenerationOf: -1},
			{Op: "match", Format: "gemini", Body: `{"systemInstruction":{"parts":[{"text":"s"}]},"contents":[{"role":"user","parts":[{"text":"hello"}]},{"role":"model","parts":[{"text":"hi"}]},{"role":"user","parts":[{"text":"more"}]}]}`, Ns: ns, GenerationOf: -1},
		}},
	}
}

func run(sc *scenario) {
	var now time.Time = time.Unix(1_700_000_000, 0)
	cfg := session.MerklePrefixMatcherConfig{TTL: time.Hour, MaxGroups: sc.Config.MaxGroups, MaxPrefixes: sc.Config.MaxPrefixes, MaxTurns: sc.Config.MaxTurns, NowFunc: func() time.Time { return now }}
	matcher := session.NewMerklePrefixMatcherWithConfig(cfg)
	for index := range sc.Steps {
		st := sc.Steps[index]
		result := stepResult{}
		prepare := func() ([]string, int, []string, string, []session.CanonicalTurn) {
			turns := session.ExtractCanonicalTurns(format(st.Format), []byte(st.Body))
			f, m, t, e := matcher.PrepareExt(turns)
			return f, m, t, e, turns
		}
		switch st.Op {
		case "advance":
			now = now.Add(time.Duration(st.Ms) * time.Millisecond)
			result.OK = true
		case "bind":
			f, m, t, e, _ := prepare()
			r := matcher.BindFingerprintsWithContext(st.Ns, f, t, e, m, st.Auth)
			result = stepResult{OK: r.SessionID != "", SessionID: r.SessionID, ParentSessionID: r.ParentSessionID, IsFork: r.IsFork, IsCompaction: r.IsCompaction, NodeKind: r.NodeKind, AccessNumber: r.AccessNumber}
		case "match":
			f, m, t, e, _ := prepare()
			r, ok := matcher.MatchFingerprintsWithContext(st.Ns, f, t, e, m)
			result = stepResult{OK: ok, AuthID: r.AuthID, SessionID: r.SessionID, ParentSessionID: r.ParentSessionID, PrefixLength: r.PrefixLength, IsFork: r.IsFork, IsCompaction: r.IsCompaction, NodeKind: r.NodeKind, AccessNumber: r.AccessNumber}
		case "touch":
			f, m, t, e, _ := prepare()
			result.OK = matcher.TouchFingerprintsWithContext(st.Ns, f, t, e, m, st.Auth)
		case "remove":
			f, _, _, _, _ := prepare()
			var generation uint64
			if st.GenerationOf >= 0 {
				generation = sc.Results[st.GenerationOf].AccessNumber
			}
			result.OK = matcher.RemoveFingerprintsBefore(st.Ns, f, st.Auth, generation)
		case "invalidate":
			matcher.InvalidateAuth(st.Auth)
			result.OK = true
		case "lookup":
			// The session id of the first bound sequence is looked up through its own match.
			f, m, t, e, _ := prepare()
			r, ok := matcher.MatchFingerprintsWithContext(st.Ns, f, t, e, m)
			if ok {
				auths, _, found := matcher.LookupSession(r.SessionID)
				result = stepResult{OK: found, SessionID: r.SessionID, Groups: auths}
			}
		}
		sc.Results = append(sc.Results, result)
	}
}

func main() {
	out := flag.String("out", "packages/models/test/fixtures/session.json", "output file")
	flag.Parse()
	scs := scenarios()
	for index := range scs {
		run(&scs[index])
	}
	doc := map[string]any{
		"canonical":           canonicalCases(),
		"derive":              deriveCases(),
		"identity":            identityCases(),
		"scenarios":           scs,
		"vertex":              vertexCases(),
		"antigravitySessions": antigravitySessions(),
	}
	encoded, err := json.MarshalIndent(doc, "", " ")
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
