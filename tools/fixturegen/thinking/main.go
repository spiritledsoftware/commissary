// Command thinking emits golden fixtures for the TypeScript thinking pipeline (packages/translation/src/thinking).
//
// Every case is executed with the real internal/thinking functions (and the real static model catalog from
// internal/registry), so the TypeScript tests can verify behavioural parity. Run from the repository root:
//
//	go run ./tools/fixturegen/thinking
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/antigravity"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/claude"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/codex"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/gemini"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/interactions"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/kimi"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/openai"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/thinking/provider/xai"
	log "github.com/sirupsen/logrus"
)

// thinkSpec / modelSpec are the camelCase JSON shape of the TypeScript ThinkingModelInfo.
type thinkSpec struct {
	Min            int      `json:"min,omitempty"`
	Max            int      `json:"max,omitempty"`
	ZeroAllowed    bool     `json:"zeroAllowed,omitempty"`
	DynamicAllowed bool     `json:"dynamicAllowed,omitempty"`
	Levels         []string `json:"levels,omitempty"`
	DisableType    string   `json:"disableType,omitempty"`
}

type modelSpec struct {
	ID                         string     `json:"id"`
	Type                       string     `json:"type,omitempty"`
	UserDefined                bool       `json:"userDefined,omitempty"`
	SupportConfigurationUpdate bool       `json:"supportConfigurationUpdate,omitempty"`
	MaxCompletionTokens        int        `json:"maxCompletionTokens,omitempty"`
	Thinking                   *thinkSpec `json:"thinking,omitempty"`
	// Web search support: the Gemini translators read it through the model lookup (ModelSupportsWebSearch).
	SupportsWebSearch  bool        `json:"supportsWebSearch,omitempty"`
	NativeCapabilities *nativeSpec `json:"nativeCapabilities,omitempty"`
}

type nativeSpec struct {
	WebSearch *bool `json:"webSearch,omitempty"`
}

func (m *modelSpec) info() *registry.ModelInfo {
	if m == nil {
		return nil
	}
	info := &registry.ModelInfo{
		ID:                         m.ID,
		Type:                       m.Type,
		UserDefined:                m.UserDefined,
		SupportConfigurationUpdate: m.SupportConfigurationUpdate,
		MaxCompletionTokens:        m.MaxCompletionTokens,
		SupportsWebSearch:          m.SupportsWebSearch,
	}
	if m.NativeCapabilities != nil {
		info.NativeCapabilities = &registry.NativeCapabilities{WebSearch: m.NativeCapabilities.WebSearch}
	}
	if m.Thinking != nil {
		info.Thinking = &registry.ThinkingSupport{
			Min:            m.Thinking.Min,
			Max:            m.Thinking.Max,
			ZeroAllowed:    m.Thinking.ZeroAllowed,
			DynamicAllowed: m.Thinking.DynamicAllowed,
			Levels:         append([]string(nil), m.Thinking.Levels...),
			DisableType:    m.Thinking.DisableType,
		}
	}
	return info
}

func specFromInfo(info *registry.ModelInfo) *modelSpec {
	spec := &modelSpec{
		ID:                         info.ID,
		Type:                       info.Type,
		UserDefined:                info.UserDefined,
		SupportConfigurationUpdate: info.SupportConfigurationUpdate,
		MaxCompletionTokens:        info.MaxCompletionTokens,
		SupportsWebSearch:          info.SupportsWebSearch,
	}
	if info.NativeCapabilities != nil && info.NativeCapabilities.WebSearch != nil {
		spec.NativeCapabilities = &nativeSpec{WebSearch: info.NativeCapabilities.WebSearch}
	}
	if info.Thinking != nil {
		spec.Thinking = &thinkSpec{
			Min:            info.Thinking.Min,
			Max:            info.Thinking.Max,
			ZeroAllowed:    info.Thinking.ZeroAllowed,
			DynamicAllowed: info.Thinking.DynamicAllowed,
			Levels:         info.Thinking.Levels,
			DisableType:    info.Thinking.DisableType,
		}
	}
	return spec
}

type configJSON struct {
	Mode   string `json:"mode"`
	Budget int    `json:"budget"`
	Level  string `json:"level"`
}

func toConfigJSON(c thinking.ThinkingConfig) configJSON {
	return configJSON{Mode: c.Mode.String(), Budget: c.Budget, Level: string(c.Level)}
}

// encodeConfig / decodeConfig use the compact "mode[:value]" form.
func encodeConfig(c thinking.ThinkingConfig) string {
	switch c.Mode {
	case thinking.ModeBudget:
		return fmt.Sprintf("budget:%d", c.Budget)
	case thinking.ModeLevel:
		return "level:" + string(c.Level)
	case thinking.ModeNone:
		if c.Budget != 0 || c.Level != "" {
			return fmt.Sprintf("none:%d:%s", c.Budget, c.Level)
		}
		return "none"
	default:
		if c.Budget != -1 || c.Level != "" {
			return fmt.Sprintf("auto:%d:%s", c.Budget, c.Level)
		}
		return "auto"
	}
}

func fromConfigJSON(c configJSON) thinking.ThinkingConfig {
	mode := thinking.ModeBudget
	switch c.Mode {
	case "level":
		mode = thinking.ModeLevel
	case "none":
		mode = thinking.ModeNone
	case "auto":
		mode = thinking.ModeAuto
	}
	return thinking.ThinkingConfig{Mode: mode, Budget: c.Budget, Level: thinking.ThinkingLevel(c.Level)}
}

type summaryJSON struct {
	Mode   string `json:"mode"`
	Detail string `json:"detail"`
}

func toSummaryJSON(c thinking.SummaryConfig) summaryJSON {
	mode := "unspecified"
	switch c.Mode {
	case thinking.SummaryDisabled:
		mode = "disabled"
	case thinking.SummaryEnabled:
		mode = "enabled"
	}
	return summaryJSON{Mode: mode, Detail: c.Detail}
}

func fromSummaryJSON(c summaryJSON) thinking.SummaryConfig {
	mode := thinking.SummaryUnspecified
	switch c.Mode {
	case "disabled":
		mode = thinking.SummaryDisabled
	case "enabled":
		mode = thinking.SummaryEnabled
	}
	return thinking.SummaryConfig{Mode: mode, Detail: c.Detail}
}

type errJSON struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Model   string `json:"model,omitempty"`
}

func toErrJSON(err error) *errJSON {
	if err == nil {
		return nil
	}
	if te, ok := err.(*thinking.ThinkingError); ok {
		return &errJSON{Code: string(te.Code), Message: te.Message, Model: te.Model}
	}
	return &errJSON{Code: "OTHER", Message: err.Error()}
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture sections
// ---------------------------------------------------------------------------------------------------------------

type suffixCase struct {
	Input     string `json:"input"`
	ModelName string `json:"modelName"`
	HasSuffix bool   `json:"hasSuffix"`
	RawSuffix string `json:"rawSuffix"`
	NumericOK bool   `json:"numericOk"`
	Numeric   int    `json:"numeric"`
	SpecialOK bool   `json:"specialOk"`
	Special   string `json:"special"`
	LevelOK   bool   `json:"levelOk"`
	Level     string `json:"level"`
	// Effort is the reasoning_effort label derived from the suffix via ExtractReasoningEffort (empty body).
	Effort string `json:"effort"`
}

type convertFixture struct {
	LevelToBudget []struct {
		Level  string `json:"level"`
		OK     bool   `json:"ok"`
		Budget int    `json:"budget"`
	} `json:"levelToBudget"`
	BudgetToLevel []struct {
		Budget int    `json:"budget"`
		OK     bool   `json:"ok"`
		Level  string `json:"level"`
	} `json:"budgetToLevel"`
	ClaudeEffort []struct {
		Level       string `json:"level"`
		SupportsMax bool   `json:"supportsMax"`
		OK          bool   `json:"ok"`
		Effort      string `json:"effort"`
	} `json:"claudeEffort"`
	HasLevel []struct {
		Levels []string `json:"levels"`
		Target string   `json:"target"`
		Result bool     `json:"result"`
	} `json:"hasLevel"`
}

// validateCase is encoded compactly: configs are "none", "auto", "budget:N" or "level:X" strings; Error is
// "CODE: message".
type validateCase struct {
	Config     string `json:"c"`
	From       string `json:"f"`
	To         string `json:"t"`
	FromSuffix bool   `json:"s,omitempty"`
	Out        string `json:"o,omitempty"`
	Error      string `json:"e,omitempty"`
}

// validateGroup shares one model definition (nil = no model info) between its cases.
type validateGroup struct {
	Model *modelSpec     `json:"model"`
	Cases []validateCase `json:"cases"`
}

type applyCase struct {
	Name        string          `json:"name,omitempty"` // generated cases are described by their fields
	Variant     string          `json:"variant"`        // plain | summary | source | modelInfo | modelInfoSummary
	Body        string          `json:"body"`
	Source      *string         `json:"source,omitempty"`
	Model       string          `json:"model"`
	From        string          `json:"from"`
	To          string          `json:"to"`
	ProviderKey string          `json:"providerKey"`
	ModelInfo   json.RawMessage `json:"modelInfo,omitempty"` // "null" = resolved but unknown
	ModelRef    string          `json:"modelRef,omitempty"`  // id in the fixture's synthetic model table
	Summary     *summaryJSON    `json:"summary,omitempty"`
	Normalized  bool            `json:"normalizedUpdatesChanged,omitempty"`
	Out         string          `json:"out,omitempty"`  // omitted when Same
	Same        bool            `json:"same,omitempty"` // output equals the input body
	Error       *errJSON        `json:"error,omitempty"`
}

type summaryExtractCase struct {
	Format     string      `json:"format"`
	Target     string      `json:"target"`
	Body       string      `json:"body"`
	Summary    summaryJSON `json:"summary"`
	Explicit   summaryJSON `json:"explicit"`
	Translated summaryJSON `json:"translated"`
}

type summaryApplyCase struct {
	Kind   string      `json:"kind"` // plain | model | translated
	Format string      `json:"format"`
	Model  string      `json:"model,omitempty"`
	Body   string      `json:"body"`
	Source string      `json:"source,omitempty"`
	Config summaryJSON `json:"config"`
	Out    string      `json:"out,omitempty"`
	Same   bool        `json:"same,omitempty"`
}

type stripCase struct {
	Provider string `json:"provider"`
	Body     string `json:"body"`
	Out      string `json:"out,omitempty"`
	Same     bool   `json:"same,omitempty"`
}

type textCase struct {
	Part string `json:"part"`
	Text string `json:"text"`
}

type usageCase struct {
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Body       string `json:"body"`
	Request    string `json:"request"`
	Translated string `json:"translated"`
}

// applierCase calls a provider applier directly (without ValidateConfig). Model is a synthetic model id,
// "catalog:<id>" or empty for no model info.
type applierCase struct {
	Applier string `json:"applier"`
	Model   string `json:"model,omitempty"`
	Config  string `json:"config"`
	Body    string `json:"body"`
	Out     string `json:"out,omitempty"`
	Same    bool   `json:"same,omitempty"`
	Error   string `json:"error,omitempty"`
}

type fixture struct {
	Catalog        map[string]*modelSpec `json:"catalog"`
	Synthetic      map[string]*modelSpec `json:"synthetic"`
	Suffix         []suffixCase          `json:"suffix"`
	Convert        convertFixture        `json:"convert"`
	Validate       []validateGroup       `json:"validate"`
	Apply          []applyCase           `json:"apply"`
	Applier        []applierCase         `json:"applier"`
	SummaryExtract []summaryExtractCase  `json:"summaryExtract"`
	SummaryApply   []summaryApplyCase    `json:"summaryApply"`
	Strip          []stripCase           `json:"strip"`
	Text           []textCase            `json:"text"`
	Usage          []usageCase           `json:"usage"`
}

func main() {
	outPath := flag.String("out", "packages/translation/test/fixtures/thinking.json", "output file")
	flag.Parse()
	log.SetOutput(io.Discard)

	fx := fixture{Catalog: buildCatalog(), Synthetic: map[string]*modelSpec{}}
	for id, model := range syntheticTable {
		fx.Synthetic[id] = model
	}
	fx.Suffix = buildSuffixCases()
	fx.Convert = buildConvertCases()
	fx.Validate = buildValidateCases()
	fx.Apply = buildApplyCases()
	fx.Applier = buildApplierCases()
	fx.SummaryExtract = buildSummaryExtractCases()
	fx.SummaryApply = buildSummaryApplyCases()
	fx.Strip = buildStripCases()
	fx.Text = buildTextCases()
	fx.Usage = buildUsageCases()

	data, err := json.Marshal(fx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*outPath, append(data, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s: catalog=%d suffix=%d validate=%d apply=%d summaryExtract=%d summaryApply=%d strip=%d text=%d usage=%d\n",
		*outPath, len(fx.Catalog), len(fx.Suffix), validateCount(fx.Validate), len(fx.Apply), len(fx.SummaryExtract),
		len(fx.SummaryApply), len(fx.Strip), len(fx.Text), len(fx.Usage))
}

// buildCatalog dumps every model of the static catalog the way registry.LookupStaticModelInfo resolves it.
func buildCatalog() map[string]*modelSpec {
	channels := []string{"claude", "gemini", "vertex", "aistudio", "codex", "kimi", "antigravity", "xai", "devin", "meta"}
	ids := map[string]struct{}{}
	for _, channel := range channels {
		for _, model := range registry.GetStaticModelDefinitionsByChannel(channel) {
			if model != nil {
				ids[model.ID] = struct{}{}
			}
		}
	}
	sorted := make([]string, 0, len(ids))
	for id := range ids {
		sorted = append(sorted, id)
	}
	sort.Strings(sorted)
	catalog := make(map[string]*modelSpec, len(sorted))
	for _, id := range sorted {
		if info := registry.LookupStaticModelInfo(id); info != nil {
			catalog[id] = specFromInfo(info)
		}
	}
	return catalog
}

func validateCount(groups []validateGroup) int {
	n := 0
	for _, g := range groups {
		n += len(g.Cases)
	}
	return n
}
