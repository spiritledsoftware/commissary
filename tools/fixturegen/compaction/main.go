// Command compaction emits golden fixtures for the TypeScript Responses compaction capsules
// (packages/models/src/executor/helps/compaction.ts and the Claude/Antigravity executors).
//
// Two kinds of fixtures: (1) the exported helps functions (summary payload preparation, capsule unsealing of
// Go-sealed capsules, expansion, summary extraction, response/stream builders) and (2) end-to-end scenarios that run
// the real Go ClaudeExecutor/AntigravityExecutor against an httptest upstream and record the upstream request
// bodies and the client output. Random values (ids, timestamps, request/session ids, capsule bytes) are normalised
// and the unsealed capsule summaries are recorded instead. Run from the repository root:
//
//	go run ./tools/fixturegen/compaction
package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator"
	cliproxyauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/tidwall/gjson"
)

var (
	capsuleRe   = regexp.MustCompile(`cpa-ag-compact-v1:[A-Za-z0-9_-]+`)
	idRe        = regexp.MustCompile(`((?:resp|cmp)_ag_compact_)\d+`)
	timeRe      = regexp.MustCompile(`"(created_at|completed_at)":\d+`)
	requestIDRe = regexp.MustCompile(`"requestId":"[^"]*"`)
	sessionIDRe = regexp.MustCompile(`"sessionId":"[^"]*"`)
	// The agent envelope's labels carry a random cascade and trajectory per session.
	labelIDRe    = regexp.MustCompile(`"(cascade_id|root_cascade_id|trajectory_id|request_id)":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	summaryModel = "claude-haiku-4-5-20251001"
)

func normalize(text string) string {
	text = capsuleRe.ReplaceAllString(text, "CAPSULE")
	text = idRe.ReplaceAllString(text, "${1}N")
	text = timeRe.ReplaceAllString(text, `"$1":0`)
	text = requestIDRe.ReplaceAllString(text, `"requestId":"R"`)
	text = sessionIDRe.ReplaceAllString(text, `"sessionId":"S"`)
	text = labelIDRe.ReplaceAllString(text, `"$1":"U`)
	return text
}

func summaries(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, capsule := range capsuleRe.FindAllString(text, -1) {
		if seen[capsule] {
			continue
		}
		seen[capsule] = true
		summary, err := helps.UnsealAntigravityCompaction(capsule)
		if err != nil {
			summary = "ERROR: " + err.Error()
		}
		out = append(out, summary)
	}
	return out
}

// ---- helper fixtures ----------------------------------------------------------------------------------------------

type sealCase struct {
	Summary   string `json:"summary"`
	Model     string `json:"model"`
	Capsule   string `json:"capsule"`
	Plaintext string `json:"plaintext"`
}

type fixedSeal struct {
	Summary   string `json:"summary"`
	Model     string `json:"model"`
	CreatedAt int64  `json:"createdAt"`
	NonceHex  string `json:"nonceHex"`
	Capsule   string `json:"capsule"`
}

type payloadCase struct {
	Name   string `json:"name"`
	Input  string `json:"input"`
	Output string `json:"output"`
}

type buildCase struct {
	Output string   `json:"output,omitempty"`
	Chunks []string `json:"chunks,omitempty"`
}

type extractCase struct {
	Name   string `json:"name"`
	Input  string `json:"input"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

type expandCase struct {
	Name   string `json:"name"`
	Input  string `json:"input"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
}

func key() []byte {
	sum := sha256.Sum256([]byte("CLIProxyAPI"))
	return sum[:]
}

// decryptPlaintext opens a capsule with the documented construction (the Go helps API only returns the summary).
func decryptPlaintext(capsule string) string {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(capsule, "cpa-ag-compact-v1:"))
	if err != nil {
		panic(err)
	}
	block, _ := aes.NewCipher(key())
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		panic(err)
	}
	return string(plain)
}

// sealFixed reproduces SealAntigravityCompaction with a fixed nonce and timestamp (the Go function reads both).
func sealFixed(summary, model string, createdAt int64, nonce []byte) string {
	plain, _ := json.Marshal(struct {
		Summary   string `json:"summary"`
		Model     string `json:"model"`
		CreatedAt int64  `json:"created_at"`
	}{summary, model, createdAt})
	block, _ := aes.NewCipher(key())
	gcm, _ := cipher.NewGCM(block)
	return "cpa-ag-compact-v1:" + base64.RawURLEncoding.EncodeToString(gcm.Seal(append([]byte(nil), nonce...), nonce, plain, nil))
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// ---- end-to-end scenarios -----------------------------------------------------------------------------------------

type scenario struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Payload  string `json:"payload"`
	Stream   bool   `json:"stream,omitempty"`
	Alt      string `json:"alt,omitempty"`
	// Rule adds an override payload rule (max_tokens / tool_choice) for the Claude model.
	Rule bool `json:"rule,omitempty"`
	// UpstreamJSON overrides the canned upstream reply (Claude only, non-stream).
	UpstreamJSON string `json:"upstreamJson,omitempty"`
	// UpstreamSSE makes the Antigravity upstream answer with an SSE frame instead of JSON.
	UpstreamSSE bool `json:"upstreamSse,omitempty"`
	// Capsules lists the summaries sealed by Go into placeholders `{{capsule:N}}` of the payload.
	Capsules []string `json:"capsules,omitempty"`
}

type scenarioResult struct {
	scenario
	Seen       []string `json:"seen"`
	Output     string   `json:"output"`
	Summaries  []string `json:"summaries,omitempty"`
	Status     int      `json:"status,omitempty"`
	ErrMessage string   `json:"errMessage,omitempty"`
	Headers    []string `json:"contentType,omitempty"`
}

const claudeJSON = `{"id":"msg_compact","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Sealed summary of the build."}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":7}}`

const claudeSSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_compact","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":11,"output_tokens":0}}}
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me examine the current build status."}}
event: content_block_stop
data: {"type":"content_block_stop","index":0}
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}
event: message_stop
data: {"type":"message_stop"}
`

const geminiJSON = `{"response":{"candidates":[{"content":{"parts":[{"text":"Summary of previous conversation"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}}`

const geminiSSE = "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Claude summary of previous conversation\"}],\"role\":\"model\"}}],\"usageMetadata\":{\"promptTokenCount\":20,\"candidatesTokenCount\":10,\"totalTokenCount\":30}}}\n\n"

func expandCapsules(s scenario) (scenario, error) {
	for i, summary := range s.Capsules {
		capsule, err := helps.SealAntigravityCompaction(summary, summaryModel)
		if err != nil {
			return s, err
		}
		s.Payload = strings.ReplaceAll(s.Payload, fmt.Sprintf("{{capsule:%d}}", i), capsule)
	}
	return s, nil
}

func runScenario(s scenario) scenarioResult {
	s, err := expandCapsules(s)
	if err != nil {
		panic(err)
	}
	result := scenarioResult{scenario: s}
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		seen = append(seen, normalize(string(body)))
		switch s.Provider {
		case "claude":
			if gjson.GetBytes(body, "stream").Bool() {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(claudeSSE))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if s.UpstreamJSON != "" {
				_, _ = w.Write([]byte(s.UpstreamJSON))
				return
			}
			_, _ = w.Write([]byte(claudeJSON))
		default:
			contents := gjson.GetBytes(body, "request.contents").Array()
			if len(contents) > 0 {
				if last := contents[len(contents)-1].Get("role").String(); last == "model" || last == "assistant" {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":{"code":400,"message":"Requests ending with a model turn are not supported."}}`))
					return
				}
			}
			if s.UpstreamSSE {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte(geminiSSE))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(geminiJSON))
		}
	}))
	defer server.Close()

	cfg := &config.Config{RequestRetry: 1}
	if s.Rule {
		cfg.Payload = config.PayloadConfig{Override: []config.PayloadRule{{
			Models: []config.PayloadModelRule{{Name: s.Model}},
			Params: map[string]any{"max_tokens": 1234, "tool_choice": map[string]any{"type": "auto"}},
		}}}
	}
	var exec cliproxyauth.ProviderExecutor
	var auth *cliproxyauth.Auth
	if s.Provider == "claude" {
		exec = executor.NewClaudeExecutor(cfg)
		auth = &cliproxyauth.Auth{Attributes: map[string]string{"api_key": "key-compaction", "base_url": server.URL}}
	} else {
		exec = executor.NewAntigravityExecutor(cfg)
		auth = &cliproxyauth.Auth{
			ID:       "antigravity-auth-test",
			Provider: "antigravity",
			Metadata: map[string]any{
				"access_token": "test-token",
				"expired":      time.Now().Add(24 * time.Hour).Format(time.RFC3339),
				"project_id":   "test-proj",
			},
			Attributes: map[string]string{"base_url": server.URL},
		}
	}
	req := cliproxyexecutor.Request{Model: s.Model, Payload: []byte(s.Payload)}
	opts := cliproxyexecutor.Options{
		SourceFormat:   sdktranslator.FormatOpenAIResponse,
		ResponseFormat: sdktranslator.FormatOpenAIResponse,
		Alt:            s.Alt,
		Stream:         s.Stream,
	}
	if s.Provider == "claude" {
		opts.OriginalRequest = []byte(s.Payload)
	}
	var output string
	var errRun error
	if s.Stream {
		stream, errStream := exec.ExecuteStream(context.Background(), auth, req, opts)
		errRun = errStream
		if errStream == nil {
			var sb strings.Builder
			for chunk := range stream.Chunks {
				if chunk.Err != nil {
					errRun = chunk.Err
					break
				}
				sb.Write(chunk.Payload)
			}
			output = sb.String()
			result.Headers = append(result.Headers, stream.Headers.Get("Content-Type"))
		}
	} else {
		resp, errExec := exec.Execute(context.Background(), auth, req, opts)
		errRun = errExec
		output = string(resp.Payload)
	}
	result.Seen = seen
	result.Output = normalize(output)
	result.Summaries = summaries(output)
	if errRun != nil {
		result.Status = 500
		if sc, ok := errRun.(interface{ StatusCode() int }); ok {
			result.Status = sc.StatusCode()
		}
		result.ErrMessage = errRun.Error()
	}
	return result
}

func scenarios() []scenario {
	toolsPayload := `{"model":"claude-haiku-4-5-20251001","stream":false,"tools":[{"type":"function","name":"check_build","description":"Check the build","parameters":{"type":"object","properties":{}}}],"input":[` +
		`{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the build next."}]},` +
		`{"type":"function_call","call_id":"call_1","name":"check_build","arguments":"{}"},` +
		`{"type":"function_call_output","call_id":"call_1","output":"build ok"},` +
		`{"type":"compaction_trigger"}]}`
	plainTrigger := func(stream bool) string {
		return fmt.Sprintf(`{"model":"claude-haiku-4-5-20251001","stream":%t,"input":[`+
			`{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the build next."}]},`+
			`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK, I will check the build."}]},`+
			`{"type":"compaction_trigger"}]}`, stream)
	}
	capsuleItem := `{"type":"compaction","encrypted_content":"{{capsule:0}}"}`
	return []scenario{
		{Name: "claude-trigger", Provider: "claude", Model: summaryModel, Payload: plainTrigger(false)},
		{Name: "claude-trigger-stream", Provider: "claude", Model: summaryModel, Payload: plainTrigger(true), Stream: true},
		{Name: "claude-alt-compact", Provider: "claude", Model: summaryModel, Alt: "responses/compact",
			Payload: `{"model":"claude-haiku-4-5-20251001","input":[{"type":"message","role":"user","content":"hello there"}],"instructions":"be brief","tools":[{"type":"function","name":"x","parameters":{"type":"object"}}]}`},
		{Name: "claude-replayed-capsule", Provider: "claude", Model: summaryModel, Capsules: []string{"Sealed summary of the build."},
			Payload: `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[` + capsuleItem + `,{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`},
		{Name: "claude-tools-kept", Provider: "claude", Model: summaryModel, Payload: toolsPayload},
		{Name: "claude-tools-flattened", Provider: "claude", Model: summaryModel,
			Payload: `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[` +
				`{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the build next."}]},` +
				`{"type":"function_call","call_id":"call_1","name":"check_build","arguments":"{\"target\":\"api\"}"},` +
				`{"type":"function_call_output","call_id":"call_1","output":"build ok"},` +
				`{"type":"compaction_trigger"}]}`},
		{Name: "claude-payload-rule-last", Provider: "claude", Model: summaryModel, Rule: true, Payload: toolsPayload},
		{Name: "claude-previous-capsule", Provider: "claude", Model: summaryModel, Capsules: []string{"Earlier sealed summary."},
			Payload: `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[` + capsuleItem + `,` +
				`{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},` +
				`{"type":"message","role":"assistant","content":[{"type":"output_text","text":"continued"}]},{"type":"compaction_trigger"}]}`},
		{Name: "claude-foreign-capsule-dropped", Provider: "claude", Model: summaryModel,
			Payload: `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[{"type":"compaction","encrypted_content":"gAAAAA-openai-native"},` +
				`{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},{"type":"compaction_trigger"}]}`},
		{Name: "claude-usage-cache", Provider: "claude", Model: summaryModel,
			UpstreamJSON: `{"id":"msg_compact","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"Sealed summary of the build."}],"stop_reason":"end_turn","usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":3,"cache_read_input_tokens":100}}`,
			Payload:      `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the build next."}]},{"type":"compaction_trigger"}]}`},
		{Name: "claude-invalid-capsule", Provider: "claude", Model: summaryModel,
			Payload: `{"model":"claude-haiku-4-5-20251001","stream":false,"input":[{"type":"compaction","encrypted_content":"cpa-ag-compact-v1:not-valid-base64"},` +
				`{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}]}`},

		{Name: "ag-trigger-stream-gemini", Provider: "antigravity", Model: "gemini-3.7-flash", Stream: true,
			Payload: `{"model":"gemini-3.7-flash","stream":true,"input":[{"type":"message","role":"user","content":"synthetic context"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic previous answer"}]},{"type":"compaction_trigger"}]}`},
		{Name: "ag-trigger-stream-claude", Provider: "antigravity", Model: "claude-sonnet-4-6", Stream: true, UpstreamSSE: true,
			Payload: `{"model":"claude-sonnet-4-6","stream":true,"input":[{"type":"message","role":"user","content":"context"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]},{"type":"compaction_trigger"}]}`},
		{Name: "ag-alt-compact", Provider: "antigravity", Model: "gemini-3.7-flash", Alt: "responses/compact",
			Payload: `{"model":"gemini-3.7-flash","input":[{"type":"message","role":"user","content":"synthetic context"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"synthetic previous answer"}]}]}`},
		{Name: "ag-replay-next-turn", Provider: "antigravity", Model: "gemini-3.7-flash", Capsules: []string{"Summary of previous conversation"},
			Payload: `{"model":"gemini-3.7-flash","input":[` + capsuleItem + `,{"type":"message","role":"user","content":"continue"}]}`},
		{Name: "ag-compact-previous-capsule", Provider: "antigravity", Model: "gemini-3.7-flash", Alt: "responses/compact", Capsules: []string{"First summary"},
			Payload: `{"model":"gemini-3.7-flash","input":[` + capsuleItem + `,{"type":"message","role":"user","content":"more work"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}]}`},
		{Name: "ag-invalid-capsule", Provider: "antigravity", Model: "gemini-3.7-flash",
			Payload: `{"model":"gemini-3.7-flash","input":[{"type":"compaction","encrypted_content":"cpa-ag-compact-v1:AAAA"},{"type":"message","role":"user","content":"continue"}]}`},
		{Name: "ag-stream-alt-compact", Provider: "antigravity", Model: "gemini-3.7-flash", Alt: "responses/compact", Stream: true,
			Payload: `{"model":"gemini-3.7-flash","input":[{"type":"message","role":"user","content":"x"}]}`},
	}
}

func helperFixtures() map[string]any {
	out := map[string]any{}

	var seals []sealCase
	for _, c := range [][2]string{
		{"Sealed summary of the build.", "claude-haiku-4-5-20251001"},
		{"Unicode \u00e9\u4e16\u754c \U0001F600 <tag> & \"quotes\" \u2028 line\nbreak\ttab", "gemini-3.7-flash"},
		{"", "m"},
		{strings.Repeat("long summary ", 400), "claude-sonnet-4-6"},
	} {
		capsule, err := helps.SealAntigravityCompaction(c[0], c[1])
		if err != nil {
			panic(err)
		}
		seals = append(seals, sealCase{Summary: c[0], Model: c[1], Capsule: capsule, Plaintext: normalizePlain(decryptPlaintext(capsule))})
	}
	out["seals"] = seals

	nonce := []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	var fixed []fixedSeal
	for _, c := range []struct {
		summary, model string
		at             int64
	}{
		{"Sealed summary of the build.", "claude-haiku-4-5-20251001", 1700000000},
		{"Unicode \u00e9\u4e16\u754c \U0001F600 <tag> & \"q\" \u2028", "gemini-3.7-flash", 1800000000},
	} {
		fixed = append(fixed, fixedSeal{c.summary, c.model, c.at, fmt.Sprintf("%x", nonce), sealFixed(c.summary, c.model, c.at, nonce)})
	}
	out["fixedSeals"] = fixed

	bad := []string{
		"not-a-capsule", "cpa-ag-compact-v1:not-valid-base64", "cpa-ag-compact-v1:AAAA", "cpa-ag-compact-v1:", "cpa-ag-compact-v1:" + strings.Repeat("A", 60),
	}
	var unseal []extractCase
	for _, c := range bad {
		summary, err := helps.UnsealAntigravityCompaction(c)
		entry := extractCase{Name: c, Output: summary}
		if err != nil {
			entry.Error = err.Error()
		}
		unseal = append(unseal, entry)
	}
	out["unsealErrors"] = unseal

	prepare := []payloadCase{}
	for name, input := range map[string]string{
		"array":    `{"model":"m","stream":true,"tools":[{"type":"function"}],"tool_choice":"auto","previous_response_id":"r","parallel_tool_calls":true,"additional_tools":[],"truncation":"auto","metadata":{"a":1},"instructions":"i","input":[{"type":"message","role":"user","content":"hi"},{"type":"compaction_trigger"}]}`,
		"string":   `{"model":"m","input":"just text"}`,
		"empty":    `{"model":"m","input":""}`,
		"noinput":  `{"model":"m"}`,
		"streamed": `{"stream":false,"model":"m","input":[{"type":"compaction_trigger"}]}`,
	} {
		prepare = append(prepare, payloadCase{Name: name, Input: input, Output: string(helps.PrepareAntigravityCompactionSummaryPayload([]byte(input), "m"))})
	}
	sort.Slice(prepare, func(i, j int) bool { return prepare[i].Name < prepare[j].Name })
	out["prepare"] = prepare

	capsule, _ := helps.SealAntigravityCompaction("Context summary text", "m")
	var expand []expandCase
	for name, input := range map[string]string{
		"capsule":   `{"model":"m","input":[{"type":"compaction","encrypted_content":"` + capsule + `"},{"type":"message","role":"user","content":"hi"}]}`,
		"none":      `{"model":"m","input":[{"type":"message","role":"user","content":"hi"}]}`,
		"notarray":  `{"model":"m","input":"hi"}`,
		"bad":       `{"model":"m","input":[{"type":"compaction","encrypted_content":"cpa-ag-compact-v1:AAAA"}]}`,
		"foreign":   `{"model":"m","input":[{"type":"compaction","encrypted_content":"gAAAA"}]}`,
		"twocaps":   `{"model":"m","input":[{"type":"compaction","encrypted_content":"` + capsule + `"},{"type":"compaction","encrypted_content":"` + capsule + `"}]}`,
		"missingec": `{"model":"m","input":[{"type":"compaction"}]}`,
	} {
		expanded, err := helps.ExpandAntigravityCompactionCapsules([]byte(input))
		entry := expandCase{Name: name, Input: strings.ReplaceAll(input, capsule, "{{capsule}}"), Output: strings.ReplaceAll(string(expanded), capsule, "{{capsule}}")}
		if err != nil {
			entry.Error = err.Error()
		}
		expand = append(expand, entry)
	}
	sort.Slice(expand, func(i, j int) bool { return expand[i].Name < expand[j].Name })
	out["expand"] = expand
	out["expandCapsule"] = capsule

	var extract []extractCase
	for name, input := range map[string]string{
		"responses":         `{"output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"A"},{"type":"output_text","text":""},{"type":"output_text","text":"B"}]},{"type":"message","content":"C"}]}`,
		"responses-empty":   `{"output":[{"type":"message","content":[]}],"content":[{"type":"text","text":"claude"}]}`,
		"gemini-response":   `{"response":{"candidates":[{"content":{"parts":[{"text":"hidden","thought":true},{"text":"G1"},{"text":"G2"}]}}]}}`,
		"gemini-bare":       `{"candidates":[{"content":{"parts":[{"text":"bare"}]}}]}`,
		"gemini-thought":    `{"candidates":[{"content":{"parts":[{"text":"hidden","thought":true}]}}],"choices":[{"message":{"content":"fallback"}}]}`,
		"claude":            `{"content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"C1"},{"type":"text","text":"C2"}]}`,
		"chat":              `{"choices":[{"message":{"content":"chat text"}}]}`,
		"none":              `{"id":"x"}`,
		"output-not-parsed": `{"output":"string"}`,
	} {
		text, err := helps.ExtractAntigravitySummaryText([]byte(input))
		entry := extractCase{Name: name, Input: input, Output: text}
		if err != nil {
			entry.Error = err.Error()
		}
		extract = append(extract, entry)
	}
	sort.Slice(extract, func(i, j int) bool { return extract[i].Name < extract[j].Name })
	out["extract"] = extract

	resp := helps.BuildAntigravityCompactionResponse("m", "cpa-ag-compact-v1:X", 11, 7, 18)
	out["response"] = buildCase{Output: normalize(string(resp))}
	var chunks []string
	for _, c := range helps.BuildAntigravityCompactionStreamChunks("m", "cpa-ag-compact-v1:X", 11, 7, 18) {
		chunks = append(chunks, normalize(string(c)))
	}
	out["stream"] = buildCase{Chunks: chunks}
	return out
}

// normalizePlain keeps the capsule plaintext but pins the creation time.
func normalizePlain(plain string) string {
	return regexp.MustCompile(`"created_at":\d+`).ReplaceAllString(plain, `"created_at":0`)
}

func main() {
	outPath := flag.String("out", "packages/models/test/fixtures/compaction.json", "output file")
	flag.Parse()
	var results []scenarioResult
	for _, s := range scenarios() {
		results = append(results, runScenario(s))
	}
	doc := map[string]any{"helpers": helperFixtures(), "scenarios": results}
	data, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("wrote %s (%d scenarios)\n", *outPath, len(results))
}
