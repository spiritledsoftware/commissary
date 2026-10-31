// Command registry emits the golden fixture for the TypeScript model registry's listings
// (packages/models/test/fixtures/registry.json): it registers clients in the real registry.ModelRegistry and records what the
// real /v1/models, /v1beta/models handlers answer, so the TypeScript tests can verify listing parity. The model
// catalogs themselves are not generated from Go any more: they come from models.dev plus the catalog additions
// (`bun run catalog:sync`, ADR 0020); the fixture's sections stay Go parity data. Run from the repository root:
//
//	go run ./tools/fixturegen/registry
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	claudemodels "github.com/router-for-me/CLIProxyAPI/v8/internal/client/claude/models"
	codexmodels "github.com/router-for-me/CLIProxyAPI/v8/internal/client/codex/models"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/client/grokbuild"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/gemini"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
	log "github.com/sirupsen/logrus"
)

// wireModel is the JSON shape of a catalog entry, including the two fields registry.ModelInfo hides from JSON.
type wireModel struct {
	*registry.ModelInfo
	NativeCapabilities         *registry.NativeCapabilities `json:"native_capabilities,omitempty"`
	SupportConfigurationUpdate bool                         `json:"support_configuration_update,omitempty"`
}

func wire(models []*registry.ModelInfo) []wireModel {
	out := make([]wireModel, 0, len(models))
	for _, m := range models {
		out = append(out, wireOne(m))
	}
	return out
}

func wireOne(m *registry.ModelInfo) wireModel {
	return wireModel{ModelInfo: m, NativeCapabilities: m.NativeCapabilities, SupportConfigurationUpdate: m.SupportConfigurationUpdate}
}

func wirePtr(m *registry.ModelInfo) *wireModel {
	if m == nil {
		return nil
	}
	w := wireOne(m)
	return &w
}

var sections = map[string]func() []*registry.ModelInfo{
	"claude":      registry.GetClaudeModels,
	"gemini":      registry.GetGeminiModels,
	"vertex":      registry.GetGeminiVertexModels,
	"aistudio":    registry.GetAIStudioModels,
	"codex-free":  registry.GetCodexFreeModels,
	"codex-team":  registry.GetCodexTeamModels,
	"codex-plus":  registry.GetCodexPlusModels,
	"codex-pro":   registry.GetCodexProModels,
	"kimi":        registry.GetKimiModels,
	"antigravity": registry.GetAntigravityModels,
	"xai":         registry.GetXAIModels,
	"devin":       registry.GetDevinModels,
	"meta":        registry.GetMetaModels,
}

// sectionProvider is the provider key a client of that section registers under.
var sectionProvider = map[string]string{
	"claude": "claude", "gemini": "gemini", "vertex": "vertex", "aistudio": "aistudio",
	"codex-free": "codex", "codex-team": "codex", "codex-plus": "codex", "codex-pro": "codex",
	"kimi": "kimi", "antigravity": "antigravity", "xai": "xai", "devin": "devin", "meta": "meta",
}

type clientSpec struct {
	ID       string            `json:"id"`
	Provider string            `json:"provider"`
	Section  string            `json:"section,omitempty"`
	Models   []json.RawMessage `json:"models,omitempty"`
}

type eventSpec struct {
	Op     string `json:"op"`
	Client string `json:"client"`
	Model  string `json:"model"`
	Reason string `json:"reason,omitempty"`
}

type scenarioSpec struct {
	Name            string       `json:"name"`
	Clients         []clientSpec `json:"clients"`
	Events          []eventSpec  `json:"events,omitempty"`
	DisableCloaking bool         `json:"disableCloaking,omitempty"`
}

type requestSpec struct {
	Name    string            `json:"name"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
}

type requestResult struct {
	requestSpec
	Status int    `json:"status"`
	Body   string `json:"body"`
}

type infoQuery struct {
	Model    string     `json:"model"`
	Provider string     `json:"provider"`
	Info     *wireModel `json:"info"`
}

type registryResult struct {
	Providers map[string][]string `json:"providers"`
	Infos     []infoQuery         `json:"infos"`
	Lookups   []infoQuery         `json:"lookups"`
	Available []wireModel         `json:"available"`
	First     string              `json:"first"`
}

// codexClientResult records what the real /v1/models?client_version= handler answered: a hash of the full body and a
// readable per-model summary (the bodies themselves are megabytes of Codex prompt templates).
type codexClientResult struct {
	Variant string `json:"variant"`
	Version string `json:"version"`
	Status  int    `json:"status"`
	Size    int    `json:"size"`
	SHA256  string `json:"sha256"`
	// Entries maps each slug to the hash of its compact JSON (entry order is map-iteration order for equal priorities).
	Entries map[string]string `json:"entries"`
	Models  []map[string]any  `json:"models"`
}

type scenarioOut struct {
	scenarioSpec
	Requests    []requestResult     `json:"requests"`
	CodexClient []codexClientResult `json:"codexClient"`
	Registry    registryResult      `json:"registry"`
}

type output struct {
	GeneratedAt int64                  `json:"generatedAt"`
	Sections    map[string][]wireModel `json:"sections"`
	Scenarios   []scenarioOut          `json:"scenarios"`
}

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func scenarios() []scenarioSpec {
	all := make([]clientSpec, 0, len(sections))
	names := make([]string, 0, len(sections))
	for name := range sections {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		all = append(all, clientSpec{ID: "c-" + name, Provider: sectionProvider[name], Section: name})
	}

	custom := []json.RawMessage{
		raw(map[string]any{"id": "gpt-5", "object": "model", "created": 1700000000, "owned_by": "openai", "type": "openai"}),
		raw(map[string]any{"id": "team-a/gpt-5", "object": "model", "owned_by": "openai", "type": "openai", "display_name": "Team <A> & GPT-5", "context_length": 400000, "max_completion_tokens": 128000}),
		raw(map[string]any{"id": "模型-1", "object": "model", "created": 1710000000, "owned_by": "x", "type": "x", "display_name": "Zeta"}),
		raw(map[string]any{"id": "gem-no-prefix", "object": "model", "created": 1, "owned_by": "google", "type": "gemini", "name": "gem-no-prefix", "version": "1", "inputTokenLimit": 10, "outputTokenLimit": 20, "supportedGenerationMethods": []string{"generateContent", "countTokens"}, "supportedInputModalities": []string{"text"}, "supportedOutputModalities": []string{"text"}}),
		raw(map[string]any{"id": "gem-prefixed", "object": "model", "created": 2, "owned_by": "google", "type": "gemini", "name": "models/gem-prefixed", "display_name": "Gem Prefixed", "description": "A described model"}),
		raw(map[string]any{"id": "claude-custom", "object": "model", "created": 1720000000, "owned_by": "anthropic", "type": "claude", "display_name": "Claude Custom", "context_length": 123456, "max_completion_tokens": 7890}),
		raw(map[string]any{"id": "bare"}),
	}

	return []scenarioSpec{
		{Name: "catalog-all", Clients: all},
		{
			Name: "overlap-providers",
			Clients: []clientSpec{
				{ID: "a1", Provider: "alpha", Models: []json.RawMessage{raw(map[string]any{"id": "shared", "object": "model", "created": 5, "owned_by": "alpha", "type": "alpha", "display_name": "Shared A"}), raw(map[string]any{"id": "only-a", "object": "model", "created": 9, "owned_by": "alpha", "type": "alpha"})}},
				{ID: "a2", Provider: "alpha", Models: []json.RawMessage{raw(map[string]any{"id": "shared", "object": "model", "created": 5, "owned_by": "alpha", "type": "alpha", "display_name": "Shared A2"})}},
				{ID: "b1", Provider: "beta", Models: []json.RawMessage{raw(map[string]any{"id": "shared", "object": "model", "created": 6, "owned_by": "beta", "type": "beta", "display_name": "Shared B"}), raw(map[string]any{"id": "dup", "object": "model", "created": 7, "owned_by": "beta", "type": "beta"}), raw(map[string]any{"id": "dup", "object": "model", "created": 7, "owned_by": "beta", "type": "beta"})}},
				{ID: "g1", Provider: "gamma", Models: []json.RawMessage{raw(map[string]any{"id": "shared", "object": "model", "created": 1, "owned_by": "gamma", "type": "gamma"})}},
			},
		},
		{
			Name: "quota-and-suspension",
			Clients: []clientSpec{
				{ID: "q1", Provider: "alpha", Models: []json.RawMessage{raw(map[string]any{"id": "m-quota", "object": "model", "created": 3, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-quota-two", "object": "model", "created": 4, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-other-susp", "object": "model", "created": 5, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-cooldown", "object": "model", "created": 6, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-both", "object": "model", "created": 7, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-ok", "object": "model", "created": 8, "owned_by": "alpha", "type": "alpha"})}},
				{ID: "q2", Provider: "alpha", Models: []json.RawMessage{raw(map[string]any{"id": "m-quota-two", "object": "model", "created": 4, "owned_by": "alpha", "type": "alpha"}), raw(map[string]any{"id": "m-both", "object": "model", "created": 7, "owned_by": "alpha", "type": "alpha"})}},
			},
			Events: []eventSpec{
				{Op: "quota", Client: "q1", Model: "m-quota"},
				{Op: "quota", Client: "q1", Model: "m-quota-two"},
				{Op: "suspend", Client: "q1", Model: "m-other-susp", Reason: "unauthorized"},
				{Op: "suspend", Client: "q1", Model: "m-cooldown", Reason: "quota"},
				{Op: "quota", Client: "q1", Model: "m-both"},
				{Op: "suspend", Client: "q1", Model: "m-both", Reason: "unauthorized"},
				{Op: "suspend", Client: "q2", Model: "m-both", Reason: "unauthorized"},
			},
		},
		{Name: "custom-shapes", Clients: []clientSpec{{ID: "x1", Provider: "custom", Models: custom}}},
		{Name: "custom-shapes-no-cloaking", DisableCloaking: true, Clients: []clientSpec{{ID: "x1", Provider: "custom", Models: custom}}},
	}
}

func decodeModels(raws []json.RawMessage) []*registry.ModelInfo {
	out := make([]*registry.ModelInfo, 0, len(raws))
	for _, r := range raws {
		var m registry.ModelInfo
		if err := json.Unmarshal(r, &m); err != nil {
			panic(err)
		}
		out = append(out, &m)
	}
	return out
}

func requestsFor(ids []string, names []string) []requestSpec {
	reqs := []requestSpec{
		{Name: "openai list", Path: "/v1/models"},
		{Name: "claude list (anthropic-version)", Path: "/v1/models", Headers: map[string]string{"Anthropic-Version": "2023-06-01"}},
		{Name: "claude list (claude-cli ua)", Path: "/v1/models", Headers: map[string]string{"User-Agent": "claude-cli/2.0.0"}},
		{Name: "grok list", Path: "/v1/models", Headers: map[string]string{"User-Agent": "Grok-Shell/1.0"}},
		{Name: "grok beats anthropic", Path: "/v1/models", Headers: map[string]string{"User-Agent": "grok-shell", "Anthropic-Version": "1"}},
		{Name: "openai detail missing", Path: "/v1/models/does-not-exist"},
		{Name: "openai detail empty", Path: "/v1/models/"},
		{Name: "claude detail missing", Path: "/v1/models/does-not-exist", Headers: map[string]string{"Anthropic-Version": "1"}},
		{Name: "gemini list", Path: "/v1beta/models"},
		{Name: "gemini detail missing", Path: "/v1beta/models/does-not-exist"},
		{Name: "gemini detail empty", Path: "/v1beta/models/"},
	}
	for _, id := range ids {
		reqs = append(reqs,
			requestSpec{Name: "openai detail " + id, Path: "/v1/models/" + id},
			requestSpec{Name: "claude detail " + id, Path: "/v1/models/" + id, Headers: map[string]string{"Anthropic-Version": "1"}},
			requestSpec{Name: "claude detail cloaked " + id, Path: "/v1/models/" + claudemodels.EnsureClaudeModelIDPrefix(id), Headers: map[string]string{"Anthropic-Version": "1"}},
		)
	}
	for _, name := range names {
		reqs = append(reqs,
			requestSpec{Name: "gemini detail " + name, Path: "/v1beta/models/" + name},
			requestSpec{Name: "gemini detail models/" + name, Path: "/v1beta/models/models/" + name},
		)
	}
	return reqs
}

type harness struct {
	openai *openai.OpenAIAPIHandler
	claude *claude.ClaudeCodeAPIHandler
	gemini *gemini.GeminiAPIHandler
}

func newHarness(disableCloaking bool, codexVariant ...string) *harness {
	cfg := &config.SDKConfig{}
	cfg.ClaudeCode.DisableCloakingModelList = disableCloaking
	for _, variant := range codexVariant {
		switch variant {
		case "multi-agent-v2":
			cfg.Client.Codex.OptimizeMultiAgentV2 = true
		case "apply-patch-flag":
			cfg.Client.Codex.EnableApplyPatch = true
		}
	}
	base := handlers.NewBaseAPIHandlers(cfg, nil)
	return &harness{
		openai: openai.NewOpenAIAPIHandler(base),
		claude: claude.NewClaudeCodeAPIHandler(base),
		gemini: gemini.NewGeminiAPIHandler(base),
	}
}

// grokModels replicates internal/api.grokModelsFromRegistryInfos (unexported).
func grokModels() grokbuild.Response {
	infos := registry.GetGlobalRegistry().GetAvailableModelInfos()
	models := make([]grokbuild.ModelInfo, 0, len(infos))
	for _, info := range infos {
		m := grokbuild.ModelInfo{ID: info.ID, DisplayName: info.DisplayName, ContextLength: info.ContextLength}
		if info.Thinking != nil {
			m.ReasoningLevels = append([]string(nil), info.Thinking.Levels...)
		}
		models = append(models, m)
	}
	return grokbuild.BuildResponse(models)
}

// serve mirrors the routing of internal/api/server_routes.go for the model list/detail routes.
func (h *harness) serve(req requestSpec) requestResult {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	httpReq := httptest.NewRequest(http.MethodGet, req.Path, nil)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	c.Request = httpReq
	switch {
	case strings.HasPrefix(req.Path, "/v1/models"):
		if rest, ok := strings.CutPrefix(req.Path, "/v1/models/"); ok {
			c.Set(handlers.ModelDetailIDContextKey, rest)
		}
		ua := httpReq.Header.Get("User-Agent")
		switch {
		case grokbuild.IsGrokShellUserAgent(ua):
			h.openai.WriteModelListResponse(c, "openai", grokModels())
		case httpReq.Header.Get("Anthropic-Version") != "" || strings.HasPrefix(ua, "claude-cli"):
			h.claude.ClaudeModels(c)
		default:
			h.openai.OpenAIModels(c)
		}
	case req.Path == "/v1beta/models":
		h.gemini.GeminiModels(c)
	case strings.HasPrefix(req.Path, "/v1beta/models/"):
		c.Params = gin.Params{{Key: "action", Value: "/" + strings.TrimPrefix(req.Path, "/v1beta/models/")}}
		h.gemini.GeminiGetHandler(c)
	default:
		panic("unsupported path " + req.Path)
	}
	return requestResult{requestSpec: req, Status: rec.Code, Body: rec.Body.String()}
}

func runScenario(spec scenarioSpec) scenarioOut {
	reg := registry.GetGlobalRegistry()
	registered := []string{}
	for _, cs := range spec.Clients {
		var models []*registry.ModelInfo
		if cs.Section != "" {
			models = sections[cs.Section]()
		} else {
			models = decodeModels(cs.Models)
		}
		reg.RegisterClient(cs.ID, cs.Provider, models)
		registered = append(registered, cs.ID)
	}
	defer func() {
		for _, id := range registered {
			reg.UnregisterClient(id)
		}
	}()
	for _, ev := range spec.Events {
		switch ev.Op {
		case "quota":
			reg.SetModelQuotaExceeded(ev.Client, ev.Model)
		case "suspend":
			reg.SuspendClientModel(ev.Client, ev.Model, ev.Reason)
		default:
			panic("unknown op " + ev.Op)
		}
	}

	available := reg.GetAvailableModelInfos()
	ids := []string{}
	names := []string{}
	for i, info := range available {
		// A bounded sample keeps fixtures small; the first/last entries and prefixed ids are always included.
		if i%7 == 0 || i == len(available)-1 || strings.Contains(info.ID, "/") {
			ids = append(ids, info.ID)
		}
		if i%11 == 0 {
			names = append(names, strings.TrimPrefix(info.Name, "models/"))
			if info.Name == "" {
				names[len(names)-1] = info.ID
			}
		}
	}

	h := newHarness(spec.DisableCloaking)
	out := scenarioOut{scenarioSpec: spec}
	for _, req := range requestsFor(ids, names) {
		out.Requests = append(out.Requests, h.serve(req))
	}

	for _, variant := range []string{"default", "multi-agent-v2", "apply-patch-flag"} {
		vh := newHarness(spec.DisableCloaking, variant)
		for _, version := range []string{"", "0.100.0", "0.150.0", "v0.144.0-beta", "cpa"} {
			res := vh.serve(requestSpec{Name: "codex-client", Path: "/v1/models?client_version=" + url.QueryEscape(version)})
			result := summarizeCodexClient(variant, version, res)
			// The large catalog keeps per-model summaries for two requests only; the others compare by hash.
			if spec.Name == "catalog-all" && !(variant == "default" && (version == "" || version == "cpa")) {
				result.Models = nil
			}
			out.CodexClient = append(out.CodexClient, result)
		}
	}

	// Registry queries: every model id ever registered, case variants and unknowns.
	queryIDs := map[string]struct{}{"unknown-model": {}, "": {}}
	providerSet := map[string]struct{}{"": {}, "alpha": {}, "beta": {}, "claude": {}, "codex": {}}
	for _, cs := range spec.Clients {
		providerSet[cs.Provider] = struct{}{}
		var models []*registry.ModelInfo
		if cs.Section != "" {
			models = sections[cs.Section]()
		} else {
			models = decodeModels(cs.Models)
		}
		for _, m := range models {
			queryIDs[m.ID] = struct{}{}
			queryIDs[strings.ToUpper(m.ID)] = struct{}{}
		}
	}
	sortedIDs := sortedKeys(queryIDs)
	sortedProviders := sortedKeys(providerSet)
	out.Registry.Providers = map[string][]string{}
	for _, id := range sortedIDs {
		if p := reg.GetModelProviders(id); len(p) > 0 {
			out.Registry.Providers[id] = p
		}
		for _, provider := range sortedProviders {
			if info := reg.GetModelInfo(id, provider); info != nil {
				out.Registry.Infos = append(out.Registry.Infos, infoQuery{Model: id, Provider: provider, Info: wirePtr(info)})
			}
		}
	}
	for _, id := range append(append([]string{}, sortedIDs...), " gpt-5.5 ", "devin/swe-2", "gpt-image-2", "grok-tts", "claude-sonnet-4-5-20250929") {
		for _, provider := range []string{"", "codex", "Claude "} {
			if info := registry.LookupModelInfo(id, provider); info != nil {
				out.Registry.Lookups = append(out.Registry.Lookups, infoQuery{Model: id, Provider: provider, Info: wirePtr(info)})
			}
		}
	}
	out.Registry.Available = wire(available)
	if first, err := reg.GetFirstAvailableModel(""); err == nil {
		out.Registry.First = first
	}
	return out
}

func summarizeCodexClient(variant, version string, res requestResult) codexClientResult {
	sum := sha256.Sum256([]byte(res.Body))
	out := codexClientResult{Variant: variant, Version: version, Status: res.Status, Size: len(res.Body), SHA256: hex.EncodeToString(sum[:])}
	var payload struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal([]byte(res.Body), &payload); err != nil {
		return out
	}
	out.Entries = map[string]string{}
	for _, model := range payload.Models {
		encoded, errMarshal := codexmodels.MarshalCompact(model)
		if errMarshal != nil {
			panic(errMarshal)
		}
		entrySum := sha256.Sum256(encoded)
		slug, _ := model["slug"].(string)
		out.Entries[slug] = hex.EncodeToString(entrySum[:])
	}
	keys := []string{"slug", "priority", "display_name", "description", "supported_reasoning_levels", "default_reasoning_level",
		"input_modalities", "supports_image_detail_original", "visibility", "apply_patch_tool_type", "supports_search_tool",
		"prefer_websockets", "multi_agent_version", "cpa_capabilities", "context_window", "max_context_window", "max_tokens",
		"service_tiers", "available_in_plans", "upgrade", "availability_nux"}
	for _, model := range payload.Models {
		summary := map[string]any{}
		for _, key := range keys {
			if value, ok := model[key]; ok {
				summary[key] = value
			} else {
				summary[key] = "<absent>"
			}
		}
		out.Models = append(out.Models, summary)
	}
	return out
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func writeJSON(path string, v any, indent bool) error {
	var data []byte
	var err error
	if indent {
		data, err = json.MarshalIndent(v, "", "  ")
	} else {
		data, err = json.Marshal(v)
	}
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func main() {
	outPath := flag.String("out", "packages/models/test/fixtures/registry.json", "fixture output file")
	flag.Parse()
	log.SetLevel(log.ErrorLevel)
	gin.SetMode(gin.TestMode)

	result := output{GeneratedAt: time.Now().UnixMilli(), Sections: map[string][]wireModel{}}
	for name, load := range sections {
		result.Sections[name] = wire(load())
	}
	for _, spec := range scenarios() {
		result.Scenarios = append(result.Scenarios, runScenario(spec))
	}
	if err := writeJSON(*outPath, result, false); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s\n", *outPath)
}
