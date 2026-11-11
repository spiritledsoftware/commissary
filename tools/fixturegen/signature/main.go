// Command signature emits golden fixtures for the TypeScript signature decision table (packages/translation/src/signature).
//
// A corpus of synthetic signature envelopes (Claude E/R/Q/CAIS, Gemini, GPT, SWE, prefixed and malformed values) is
// run through the real internal/signature functions: provider detection, compatibility decisions for every target
// provider, Claude validation under each option set and the Antigravity Claude normalisation. Run from the
// repository root:
//
//	go run ./tools/fixturegen/signature
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/signature"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/signature/signaturetest"
	"google.golang.org/protobuf/encoding/protowire"
)

func varint(dst []byte, field protowire.Number, value uint64) []byte {
	return protowire.AppendVarint(protowire.AppendTag(dst, field, protowire.VarintType), value)
}

func bytesField(dst []byte, field protowire.Number, value []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(dst, field, protowire.BytesType), value)
}

func b64(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }

// metaSignature builds a synthetic Meta Muse envelope: the observed five-byte header, then deterministic filler up to
// 45 + payloadLen bytes, in unpadded base64url. mutate may corrupt the decoded bytes first.
func metaSignature(payloadLen int, mutate func([]byte)) string {
	decoded := make([]byte, 45+payloadLen)
	copy(decoded, []byte{0x43, 0xe3, 0xda, 0x0e, 0x01})
	for i := 5; i < len(decoded); i++ {
		decoded[i] = byte(i*31 + 7)
	}
	if mutate != nil {
		mutate(decoded)
	}
	return base64.RawURLEncoding.EncodeToString(decoded)
}

// bareTink builds a Vertex-style bare-Tink signature: prefix byte, a four-byte key id, then filler to length n.
func bareTink(keyID [4]byte, n int) string {
	payload := append([]byte{0x01}, keyID[:]...)
	for len(payload) < n {
		payload = append(payload, byte(0xA0+len(payload)%0x20))
	}
	return b64(payload)
}

// routerSuffix is OpenRouter's private routing tag: one "." and alphanumeric characters.
func routerSuffix(n int) string {
	suffix := ""
	for len(suffix) < n {
		suffix += "Ab3"
	}
	return "." + suffix[:n]
}

// classicPayload builds the 0x12 envelope: top-level field 2 container -> field 1 channel block.
func classicPayload(channelID uint64, infra *uint64, model string) []byte {
	var channel []byte
	channel = varint(channel, 1, channelID)
	if infra != nil {
		channel = varint(channel, 2, *infra)
	}
	channel = varint(channel, 3, 2)
	channel = bytesField(channel, 5, make([]byte, 64))
	if model != "" {
		channel = bytesField(channel, 6, []byte(model))
	}
	container := bytesField(nil, 1, channel)
	container = bytesField(container, 2, make([]byte, 12))
	return bytesField(nil, 2, container)
}

func cais(version uint64, modelText string) []byte {
	var channel []byte
	channel = varint(channel, 1, 16)
	channel = varint(channel, 3, 2)
	channel = bytesField(channel, 5, make([]byte, 64))
	if modelText != "" {
		channel = bytesField(channel, 6, []byte(modelText))
	}
	channel = bytesField(channel, 8, []byte("thinking"))
	container := bytesField(nil, 1, channel)
	payload := varint(nil, 1, version)
	payload = bytesField(payload, 2, container)
	return varint(payload, 3, 1)
}

// gemini builds the protobuf_field_2 envelope around a Tink-prefixed opaque payload.
func geminiField2(opaque []byte) []byte {
	return bytesField(nil, 2, bytesField(nil, 1, opaque))
}

type result struct {
	Grok           bool              `json:"grok"`
	Recognized     bool              `json:"recognized"`
	GPT            bool              `json:"gpt"`
	GeminiReplay   map[string]string `json:"geminiReplay"`
	Name           string            `json:"name"`
	Signature      string            `json:"signature"`
	Detected       map[string]string `json:"detected"`
	Compatible     map[string]any    `json:"compatible"`
	Decisions      map[string]any    `json:"decisions"`
	AntigravityTag any               `json:"antigravityClaude"`
	ClaudeValid    map[string]bool   `json:"claudeValid"`
	Normalized     map[string]any    `json:"normalized"`
}

type decision struct {
	Compatible bool   `json:"compatible"`
	Action     string `json:"action"`
	Detected   string `json:"detected"`
	Normalized string `json:"normalized"`
	Replace    string `json:"replacement"`
	Reason     string `json:"reason"`
}

type sanitizeCase struct {
	Name   string          `json:"name"`
	Mode   string          `json:"mode"`
	Model  string          `json:"model"`
	Input  any             `json:"input"`
	Output json.RawMessage `json:"output"`
	Report map[string]any  `json:"report"`
}

type geminiCase struct {
	Name     string          `json:"name"`
	Input    json.RawMessage `json:"input"`
	Thought  string          `json:"thought"`
	Pairing  string          `json:"pairing"`
	Sanitize json.RawMessage `json:"sanitize"`
}

type namedSignature struct{ name, sig string }

func samples2names(samples []struct{ name, sig string }) []namedSignature {
	out := make([]namedSignature, 0, len(samples))
	for _, s := range samples {
		out = append(out, namedSignature{name: s.name, sig: s.sig})
	}
	return out
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func reportOf(r signature.SignatureSanitizeReport) map[string]any {
	reasons := make([]string, 0, len(r.Decisions))
	for _, d := range r.Decisions {
		reasons = append(reasons, d.Reason)
	}
	return map[string]any{
		"targetProvider":     string(r.TargetProvider),
		"preserved":          r.Preserved,
		"droppedBlocks":      r.DroppedBlocks,
		"droppedSignatures":  r.DroppedSignatures,
		"replacedSignatures": r.ReplacedSignatures,
		"decisions":          len(r.Decisions),
		"reasons":            reasons,
	}
}

// buildSanitizeCases runs the Claude messages sanitisers over one history per signature sample.
func buildSanitizeCases(samples []namedSignature) []sanitizeCase {
	history := func(sig string) map[string]any {
		return map[string]any{
			"model": "claude-sonnet-4-5",
			"messages": []any{
				map[string]any{"role": "user", "content": "hi"},
				map[string]any{"role": "assistant", "content": []any{
					map[string]any{"type": "thinking", "thinking": "t", "signature": sig},
					map[string]any{"type": "text", "text": "x"},
					map[string]any{
						"type": "tool_use", "id": "1", "name": "n", "input": map[string]any{},
						"signature": sig, "thoughtSignature": sig, "model": "m",
						"extra_content": map[string]any{"google": map[string]any{"thought_signature": sig}},
					},
				}},
				map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "only", "signature": sig}}},
				map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "", "signature": ""}}},
				map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "words", "signature": ""}}},
				map[string]any{"role": "assistant", "content": "plain"},
			},
		}
	}
	models := []string{"claude-sonnet-4-5", "gemini-3-pro-high", "gpt-5", "kimi-k2", "grok-4", "mystery"}
	var cases []sanitizeCase
	run := func(name, mode, model string, apply func(payload []byte) ([]byte, signature.SignatureSanitizeReport)) {
		input := mustJSON(history(name2sig(samples, name)))
		out, report := apply(input)
		cases = append(cases, sanitizeCase{Name: name, Mode: mode, Model: model, Output: json.RawMessage(out), Report: reportOf(report)})
	}
	for _, s := range samples {
		for _, model := range models {
			model := model
			run(s.name, "forModel", model, func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
				return signature.SanitizeClaudeMessagesSignaturesForModel(payload, model)
			})
		}
		run(s.name, "claudeUpstream", "claude-sonnet-4-5", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.SanitizeClaudeMessagesForClaudeUpstream(payload, "claude-sonnet-4-5")
		})
		run(s.name, "claudeUpstreamPreserve", "claude-sonnet-4-5", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.SanitizeClaudeMessagesForClaudeUpstream(payload, "claude-sonnet-4-5", true)
		})
		run(s.name, "targetKeepEmpty", "", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.SanitizeClaudeMessagesSignaturesForTarget(payload, signature.ClaudeMessagesSignatureSanitizeOptions{TargetProvider: signature.SignatureProviderClaude})
		})
		run(s.name, "targetModelOnly", "gemini-3-flash", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.SanitizeClaudeMessagesSignaturesForTarget(payload, signature.ClaudeMessagesSignatureSanitizeOptions{TargetProvider: signature.SignatureProviderUnknown, TargetModel: "gemini-3-flash", DropEmptyMessages: true})
		})
		run(s.name, "stripEmpty", "", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.StripInvalidClaudeThinkingBlocksAndEmptyMessages(payload, signature.ClaudeSignatureValidationOptions{AllowEmptySignatureWithEmptyText: true}), signature.SignatureSanitizeReport{}
		})
		run(s.name, "stripInvalid", "", func(payload []byte) ([]byte, signature.SignatureSanitizeReport) {
			return signature.StripInvalidClaudeThinkingBlocks(payload, signature.ClaudeSignatureValidationOptions{Strict: true}), signature.SignatureSanitizeReport{}
		})
	}
	return cases
}

func name2sig(samples []namedSignature, name string) string {
	for _, s := range samples {
		if s.name == name {
			return s.sig
		}
	}
	return ""
}

// buildGeminiCases checks the Gemini validators and the request sanitiser on hand-written contents.
func buildGeminiCases(samples []namedSignature) []geminiCase {
	part := func(fn string, sig any) map[string]any {
		p := map[string]any{"functionCall": map[string]any{"name": fn, "args": map[string]any{}, "id": "c-" + fn}}
		if sig != nil {
			p["thoughtSignature"] = sig
		}
		return p
	}
	resp := func(fn string) map[string]any {
		return map[string]any{"functionResponse": map[string]any{"name": fn, "id": "c-" + fn, "response": map[string]any{}}}
	}
	var cases []geminiCase
	add := func(name string, payload any) {
		raw := mustJSON(payload)
		c := geminiCase{Name: name, Input: raw}
		if err := signature.ValidateGeminiThoughtSignatures(raw, signature.GeminiThoughtSignatureValidationOptions{AllowBypassSentinel: true, RequireKnownEnvelope: true}); err != nil {
			c.Thought = err.Error()
		}
		if err := signature.ValidateGeminiFunctionCallPairing(raw); err != nil {
			c.Pairing = err.Error()
		}
		c.Sanitize = signature.SanitizeGeminiRequestThoughtSignatures(append([]byte(nil), raw...), "contents")
		cases = append(cases, c)
	}
	contents := func(items ...any) map[string]any { return map[string]any{"contents": items} }
	modelTurn := func(parts ...any) map[string]any { return map[string]any{"role": "model", "parts": parts} }
	userTurn := func(parts ...any) map[string]any { return map[string]any{"role": "user", "parts": parts} }
	for _, s := range samples {
		add("sig/"+s.name, contents(
			userTurn(map[string]any{"text": "go"}),
			modelTurn(part("a", s.sig), part("b", nil), part("c", s.sig)),
			userTurn(resp("a"), resp("b"), resp("c")),
		))
		add("text-sig/"+s.name, contents(modelTurn(map[string]any{"text": "t", "thought": true, "thoughtSignature": s.sig})))
	}
	// A text part ends a parallel functionCall group: the next call is the first of a new group (Go e5434f65).
	text := map[string]any{"text": "more"}
	sentinel := "skip_thought_signature_validator"
	add("call-after-text-unsigned", contents(modelTurn(part("a", nil), part("b", nil), text, part("c", nil))))
	add("call-after-text-bypass", contents(modelTurn(part("a", sentinel), part("b", sentinel), text, part("c", sentinel))))
	add("call-after-empty-carrier-text", contents(modelTurn(part("a", nil), map[string]any{"text": "", "thoughtSignature": sentinel}, part("c", nil))))
	add("call-after-thought-part", contents(modelTurn(part("a", sentinel), map[string]any{"text": "hidden", "thought": true}, part("b", sentinel))))
	add("empty", map[string]any{})
	add("no-contents-array", map[string]any{"contents": "x"})
	add("request-contents", map[string]any{"request": contents(userTurn(map[string]any{"text": "go"}), modelTurn(part("a", nil)))})
	add("pending-final", contents(userTurn(map[string]any{"text": "go"}), modelTurn(part("a", nil))))
	add("response-without-call", contents(userTurn(resp("a"))))
	add("count-mismatch", contents(modelTurn(part("a", nil), part("b", nil)), userTurn(resp("a"))))
	add("id-mismatch", contents(modelTurn(part("a", nil)), userTurn(map[string]any{"functionResponse": map[string]any{"name": "a", "id": "zzz"}})))
	add("missing-response-id", contents(modelTurn(part("a", nil)), userTurn(map[string]any{"functionResponse": map[string]any{"name": "a"}})))
	add("name-mismatch", contents(modelTurn(map[string]any{"functionCall": map[string]any{"name": "a"}}), userTurn(map[string]any{"functionResponse": map[string]any{"name": "b"}})))
	add("missing-response-name", contents(modelTurn(map[string]any{"functionCall": map[string]any{"name": "a"}}), userTurn(map[string]any{"functionResponse": map[string]any{"id": "x"}})))
	add("missing-call-name", contents(modelTurn(map[string]any{"functionCall": map[string]any{"args": map[string]any{}}})))
	add("interleaved", contents(modelTurn(part("a", nil), resp("a"))))
	add("call-before-pending", contents(modelTurn(part("a", nil)), modelTurn(part("b", nil))))
	add("model-before-response", contents(modelTurn(part("a", nil)), modelTurn(map[string]any{"text": "oops"})))
	add("user-before-response", contents(modelTurn(part("a", nil)), userTurn(map[string]any{"text": "note"}), userTurn(resp("a"))))
	add("empty-parts-while-pending", contents(modelTurn(part("a", nil)), map[string]any{"role": "user", "parts": []any{}}))
	add("bypass-on-sibling", contents(modelTurn(part("a", "skip_thought_signature_validator"), part("b", "skip_thought_signature_validator"))))
	add("empty-signature-first", contents(modelTurn(part("a", ""))))
	add("response-with-signature", contents(modelTurn(part("a", nil)), userTurn(map[string]any{"functionResponse": map[string]any{"name": "a", "id": "c-a"}, "thoughtSignature": "x"})))
	add("snake-case-signature", contents(modelTurn(map[string]any{"functionCall": map[string]any{"name": "a", "id": "c-a"}, "thought_signature": "skip_thought_signature_validator"})))
	add("server-tool-block", contents(modelTurn(map[string]any{"toolCall": map[string]any{"x": 1}, "thoughtSignature": "junk"})))
	return cases
}

func main() {
	out := flag.String("out", "packages/translation/test/fixtures/signature.json", "output file")
	flag.Parse()

	infra1, infra2 := uint64(1), uint64(2)
	classicE := b64(classicPayload(11, nil, ""))
	classicE16 := b64(classicPayload(16, nil, "claude-opus-4-7"))
	classicEGoogle := b64(classicPayload(11, &infra2, ""))
	classicEAws := b64(classicPayload(12, &infra1, ""))
	classicNoChannel := b64(bytesField(nil, 2, bytesField(nil, 1, varint(nil, 3, 1))))
	rForm := b64([]byte(classicE))
	rForm16 := b64([]byte(classicE16))
	rFormGoogle := b64([]byte(classicEGoogle))
	badMarker := b64([]byte{0x13, 0x00, 0x01, 0x02})
	rBadStrict := b64([]byte(b64([]byte{0x12, 0x01, 0x00})))
	caqs := signaturetest.AntigravityCAQS()
	caisOpus5 := b64(cais(2, "claude-opus-5"))
	caisNoModel := b64(cais(2, ""))
	geminiTink := b64(geminiField2(append([]byte{0x01}, make([]byte, 40)...)))
	geminiUUID := b64(geminiField2([]byte("123e4567-e89b-12d3-a456-426614174000")))
	fernet := make([]byte, 73)
	fernet[0] = 0x80
	for i := 9; i < len(fernet); i++ {
		fernet[i] = byte(i * 7)
	}
	gptFernet := base64.RawURLEncoding.EncodeToString(fernet)
	kimiRaw := make([]byte, 0, 3255)
	for block := sha256.Sum256([]byte("kimi")); len(kimiRaw) < 3255; block = sha256.Sum256(block[:]) {
		kimiRaw = append(kimiRaw, block[:]...)
	}
	kimiLike := base64.RawStdEncoding.EncodeToString(kimiRaw[:3255])
	caqsBadInfra := func() string {
		var channel []byte
		channel = varint(channel, 1, 18)
		channel = varint(channel, 2, 1)
		channel = bytesField(channel, 8, []byte("thinking"))
		container := bytesField(nil, 1, channel)
		container = bytesField(container, 5, make([]byte, 100))
		payload := varint(nil, 1, 4)
		payload = bytesField(payload, 2, container)
		return b64([]byte(b64(payload)))
	}()

	grokRaw := make([]byte, 0, 192)
	for block := sha256.Sum256([]byte("grok")); len(grokRaw) < 192; block = sha256.Sum256(block[:]) {
		grokRaw = append(grokRaw, block[:]...)
	}
	grokLike := base64.RawStdEncoding.EncodeToString(grokRaw[:150])
	grokShort := base64.RawStdEncoding.EncodeToString(grokRaw[:20])
	grokLowEntropy := base64.RawStdEncoding.EncodeToString(make([]byte, 90))
	grokPadded := base64.StdEncoding.EncodeToString(grokRaw[:100])
	// Uniform xAI ciphertext starts with the Tink prefix byte about once in 256 values; it must not look like Gemini.
	grokTinkByte := append([]byte{0x01, 0x69, 0x14, 0x7d, 0x13}, grokRaw[5:150]...)
	grokTinkLike := base64.RawStdEncoding.EncodeToString(grokTinkByte)
	vertexKey, otherKey := [4]byte{0x8f, 0x3d, 0x6b, 0x5f}, [4]byte{0x69, 0x14, 0x7d, 0x13}
	metaNative := metaSignature(1024, nil)
	gptRouted := gptFernet + routerSuffix(79)

	samples := []struct{ name, sig string }{
		{"grok-like-150", grokLike},
		{"grok-like-prefixed", "claude#" + grokLike},
		{"grok-too-short", grokShort},
		{"grok-low-entropy", grokLowEntropy},
		{"grok-padded", grokPadded},
		{"grok-leading-space", " " + grokLike},
		{"grok-url-chars", "abc-_" + grokLike},
		{"grok-like-routed", grokLike + routerSuffix(62)},
		{"grok-like-empty-suffix", grokLike + "."},
		{"grok-like-double-dot-suffix", grokLike + ".a.b"},
		{"grok-tink-prefix-byte", grokTinkLike},
		{"empty", ""},
		{"whitespace", "   "},
		{"classic-E-channel11", classicE},
		{"classic-E-channel16-model", classicE16},
		{"classic-E-google", classicEGoogle},
		{"classic-E-aws-channel12", classicEAws},
		{"classic-E-no-channel-id", classicNoChannel},
		{"classic-R-channel11", rForm},
		{"classic-R-channel16-model", rForm16},
		{"classic-R-google", rFormGoogle},
		{"E-bad-marker", badMarker},
		{"R-valid-base64-bad-strict", rBadStrict},
		{"antigravity-CAQS", caqs},
		{"antigravity-CAQS-wrong-infra", caqsBadInfra},
		{"antigravity-CAQS-channel19", signaturetest.AntigravityCAQSWithChannel(19)},
		{"claude-CAIS-opus5", caisOpus5},
		{"claude-CAIS-no-model", caisNoModel},
		{"gemini-tink-envelope", geminiTink},
		{"gemini-uuid-envelope", geminiUUID},
		{"gemini-bare-tink-vertex", bareTink(vertexKey, 405)},
		{"gemini-bare-tink-other-key", bareTink(otherKey, 405)},
		{"gemini-bare-tink-short", b64(append([]byte{0x01, 0x8f, 0x3d}, make([]byte, 10)...))},
		{"prefixed-gemini-bare-tink", "gemini#" + bareTink(vertexKey, 405)},
		{"gemini-bypass-skip", "skip_thought_signature_validator"},
		{"gemini-bypass-context", "context_engineering_is_the_way_to_go"},
		{"gpt-fernet", gptFernet},
		{"gpt-fernet-routed", gptRouted},
		{"gpt-fernet-empty-suffix", gptFernet + "."},
		{"gpt-fernet-bad-suffix", gptFernet + ".bad_char"},
		{"gpt-fernet-double-dot-suffix", gptFernet + ".a.b"},
		{"meta-muse-1024", metaNative},
		{"meta-muse-2048", metaSignature(2048, nil)},
		{"meta-muse-routed", metaNative + routerSuffix(67)},
		{"meta-muse-oversized-suffix", metaNative + routerSuffix(129)},
		{"meta-muse-dash-suffix", metaNative + ".ab-cd"},
		{"meta-muse-non-bucket", metaSignature(1025, nil)},
		{"meta-muse-below-minimum", metaSignature(512, nil)},
		{"meta-muse-bad-header", metaSignature(1024, func(b []byte) { b[2] ^= 0xff })},
		{"meta-muse-padded", metaNative + "="},
		{"meta-muse-prefixed", "meta#" + metaNative},
		{"kimi-like-4340", kimiLike},
		{"swe-sealed", "sealed.v1.abcdef"},
		{"prefixed-claude-R", "claude#" + rForm},
		{"prefixed-gemini-tink", "gemini#" + geminiTink},
		{"prefixed-gemini-bypass", "gemini#skip_thought_signature_validator"},
		{"prefixed-gpt-fernet", "gpt#" + gptFernet},
		{"prefixed-codex-fernet", "codex#" + gptFernet},
		{"prefixed-swe", "swe#sealed.v1.abcdef"},
		{"double-prefix", "claude#gemini#" + rForm},
		{"unknown-prefix", "foo#" + rForm},
		{"hash-in-middle", "abc#def#ghi"},
		{"random-text", "not a signature at all"},
		{"padded-R", "  " + rForm + "  "},
		{"claude-E-newline", classicE[:20] + "\n" + classicE[20:]},
	}
	targets := []signature.SignatureProvider{
		signature.SignatureProviderClaude, signature.SignatureProviderGemini, signature.SignatureProviderGPT,
		signature.SignatureProviderKimi, signature.SignatureProviderGrok, signature.SignatureProviderSWE,
		signature.SignatureProviderMeta, signature.SignatureProviderUnknown,
	}
	kinds := []signature.SignatureBlockKind{
		signature.SignatureBlockKindUnknown, signature.SignatureBlockKindClaudeThinking,
		signature.SignatureBlockKindGeminiModelPart, signature.SignatureBlockKindGeminiFunctionCall,
	}
	optionSets := map[string]signature.ClaudeSignatureValidationOptions{
		"default":    {},
		"strict":     {Strict: true},
		"prefixOnly": {PrefixOnly: true},
		"base64Only": {Base64Only: true},
	}

	results := make([]result, 0, len(samples))
	for _, s := range samples {
		r := result{
			Name:        s.name,
			Signature:   s.sig,
			Detected:    map[string]string{},
			Decisions:   map[string]any{},
			ClaudeValid: map[string]bool{},
			Normalized:  map[string]any{},
			Compatible:  map[string]any{},
		}
		for _, kind := range kinds {
			r.Detected[string(kind)] = string(signature.DetectSignatureProviderForBlock(s.sig, kind))
			for _, target := range targets {
				d := signature.DecideSignatureCompatibility(target, s.sig, kind)
				r.Decisions[string(target)+"/"+string(kind)] = decision{
					Compatible: d.Compatible,
					Action:     string(d.Action),
					Detected:   string(d.DetectedProvider),
					Normalized: d.NormalizedSignature,
					Replace:    d.ReplacementSignature,
					Reason:     d.Reason,
				}
			}
		}
		for name, opts := range optionSets {
			r.ClaudeValid[name] = signature.IsValidClaudeThinkingSignature(s.sig, opts)
			normalized, err := signature.NormalizeClaudeThinkingSignature(s.sig, opts)
			if err != nil {
				r.Normalized[name] = nil
			} else {
				r.Normalized[name] = normalized
			}
			native, errNative := signature.NormalizeClaudeProviderNativeThinkingSignature(s.sig, opts)
			if errNative != nil {
				r.Normalized[name+"Native"] = nil
			} else {
				r.Normalized[name+"Native"] = native
			}
		}
		if normalized, ok := signature.CompatibleAntigravityClaudeThinkingSignature(s.sig); ok {
			r.AntigravityTag = normalized
		}
		for _, provider := range []signature.SignatureProvider{signature.SignatureProviderClaude, signature.SignatureProviderGemini, signature.SignatureProviderGPT, signature.SignatureProviderMeta} {
			if normalized, ok := signature.CompatibleSignatureForProvider(provider, s.sig); ok {
				r.Compatible[string(provider)] = normalized
			} else {
				r.Compatible[string(provider)] = nil
			}
		}
		r.Grok = signature.IsValidGrokEncryptedContent(s.sig)
		r.Recognized = signature.IsRecognizedReasoningSignature(s.sig)
		r.GPT = signature.IsValidGPTReasoningSignature(s.sig)
		r.GeminiReplay = map[string]string{}
		for _, kind := range kinds {
			r.GeminiReplay[string(kind)] = signature.GeminiReplaySignatureOrBypass(s.sig, kind)
		}
		results = append(results, r)
	}

	models := []string{"claude-sonnet-4-5", "Claude-Opus-4", "gemini-3-pro-high", "gemini-3-flash", "gpt-5", "gpt-oss-120b-medium",
		"o3-mini", "kimi-k2", "moonshot-v1", "k2-thinking", "grok-4", "swe-1.6", "swe-1", "some-model", " Claude ", "o4", "my-openai-x", "codex-mini",
		// Meta Muse, and the last "/" or ":" segment deciding the family before the whole string.
		"muse-spark-1.3", "Muse-Wonder-1.0", "muse", "muse_spark_1_3", "meta/muse", "meta/muse-spark-1.2", "meta-muse-spark", "openai-compatible/muse-spark-1.3",
		"museum-1", "amuse-model", "meta-llama-4", "muse-proxy/gpt-5.4", "openrouter/anthropic/claude-sonnet-4-6", "vendor:grok-4", "gemini-proxy/custom", "provider/"}
	modelProviders := map[string]string{}
	for _, m := range models {
		modelProviders[m] = string(signature.SignatureProviderFromModelName(m))
	}

	sanitizeCases := buildSanitizeCases(samples2names(samples))
	geminiCases := buildGeminiCases(samples2names(samples))
	encoded, err := json.MarshalIndent(map[string]any{
		"samples":        results,
		"modelProviders": modelProviders,
		"sanitize":       sanitizeCases,
		"gemini":         geminiCases,
	}, "", " ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d signature samples to %s\n", len(results), *out)
}
