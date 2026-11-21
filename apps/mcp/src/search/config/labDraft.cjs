/**
 * SEARCH'S CONFIG IN A LAB DRAFT: search's entry of the architectures registry (`packages/tex/src/architectures.cjs`),
 * named for search's callers. A draft tags search's steps `graph: "search"`, a tag that lives only in the Lab.
 */
"use strict";

const { architectureOf, configFromDraft, draftStepsOf, texSideOf } = require("../../../../../packages/tex/src/architectures.cjs");

const SEARCH_PAGE = "search";
const SEARCH = architectureOf(SEARCH_PAGE);

const isSearchStep = (n) => Boolean(n) && n.graph === SEARCH_PAGE;

/** Search's config as a draft's steps and wires: each step tagged for the Search page. */
const labSearchGraph = (config = SEARCH.config) => draftStepsOf(SEARCH, config);

/** A draft's search steps as a search config, or null when the draft holds none (it then searches as main does). */
const searchConfigFromDraft = (graph) => configFromDraft(graph, SEARCH);

module.exports = { SEARCH_PAGE, isSearchStep, labSearchGraph, searchConfigFromDraft, texSideOf };
