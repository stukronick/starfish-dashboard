// src/hooks/usePortfolio.js
import { useState, useEffect, useCallback } from 'react';
import { fetchPortfolio, fetchSyndicators } from '../api.js';
import { FALLBACK_DATA } from '../fallback-data.js';

export function usePortfolio() {
  // Two separate data stores
  const [portfolioData, setPortfolioData] = useState(null);   // funder-wide (no syndicator)
  const [syndicatorData, setSyndicatorData] = useState(null);  // syndicator-specific (with subledger)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);

  // Syndicator state
  const [syndicators, setSyndicators] = useState([]);
  const [selectedSyndicatorId, setSelectedSyndicatorId] = useState(null);
  const [syndicatorsLoading, setSyndicatorsLoading] = useState(true);

  // Load syndicators on mount
  useEffect(() => {
    async function loadSyndicators() {
      setSyndicatorsLoading(true);
      try {
        const list = await fetchSyndicators();
        setSyndicators(list);
        const first = list.find(s => s.totalInvested > 100);
        if (first) setSelectedSyndicatorId(first.id);
      } catch (err) {
        console.warn('Failed to load syndicators:', err.message);
        setSyndicators([{ id: 'fallback', name: 'Demo Syndicator', totalInvested: 0 }]);
      } finally {
        setSyndicatorsLoading(false);
      }
    }
    loadSyndicators();
  }, []);

  // Load BOTH datasets: portfolio (no syndicator) + syndicator-specific
  useEffect(() => {
    if (syndicatorsLoading) return;

    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        // Fetch both in parallel
        const [portfolioResult, syndicatorResult] = await Promise.all([
          fetchPortfolio(null),                    // Portfolio Overview: no syndicator filter
          selectedSyndicatorId
            ? fetchPortfolio(selectedSyndicatorId)  // Syndicator View: with subledger
            : Promise.resolve(null),
        ]);

        if (!cancelled) {
          setPortfolioData(portfolioResult);
          setSyndicatorData(syndicatorResult || portfolioResult);
          setSource('live');
          setError(null);
        }
      } catch (err) {
        console.warn('API fetch failed, using fallback:', err.message);
        if (!cancelled) {
          setPortfolioData(FALLBACK_DATA);
          setSyndicatorData(FALLBACK_DATA);
          setSource('fallback');
          setError(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedSyndicatorId, syndicatorsLoading]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [portfolioResult, syndicatorResult] = await Promise.all([
        fetchPortfolio(null),
        selectedSyndicatorId ? fetchPortfolio(selectedSyndicatorId) : Promise.resolve(null),
      ]);
      setPortfolioData(portfolioResult);
      setSyndicatorData(syndicatorResult || portfolioResult);
      setSource('live');
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedSyndicatorId]);

  const selectSyndicator = useCallback((id) => {
    setSelectedSyndicatorId(id);
  }, []);

  return {
    portfolioData,     // For Portfolio Overview (all syndicators, no subledger)
    syndicatorData,    // For Syndicator View (specific syndicator + subledger)
    loading,
    error,
    source,
    refresh,
    syndicators,
    selectedSyndicatorId,
    selectSyndicator,
    syndicatorsLoading,
  };
}
