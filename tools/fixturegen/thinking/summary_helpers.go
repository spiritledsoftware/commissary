package main

import (
	"github.com/MoeForge/moego/ojson"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"
)

// thinking.GetThinkingText takes an ojson.Result in the reference's internal/thinking API.
func thinkingText(part string) string {
	return thinking.GetThinkingText(ojson.Parse(part))
}
