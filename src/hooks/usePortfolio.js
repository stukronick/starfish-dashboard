// src/hooks/usePortfolio.js
import { useState, useEffect, useCallback } from 'react';
import { fetchPortfolio, fetchSyndicators } from '../api.js';
import { FALLBACK_DATA } from '../fallback-data.js';

export function usePortfolio() {
  const [data, setData] = useState(null);
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
        // Auto-select the first syndicator with real investment
        const first = list.find(s => s.totalInvested > 100);
        if (first) setSelectedSyndicatorId(first.id);
      } catch (err) {
        console.warn('Failed to load syndicators:', err.message);
        // Fallback syndicators
        setSyndicators([{ id: 'fallback', name: 'LMJS Capital (Demo)', totalInvested: 402430 }]);
      } finally {
        setSyndicatorsLoading(false);
      }
    }
    loadSyndicators();
  }, []);

  // Load portfolio when syndicator changes
  useEffect(() => {
    if (syndicatorsLoading) return; // wait for syndicators to load first

    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const result = await fetchPortfolio(selectedSyndicatorId);
        if (!cancelled) {
          setData(result);
          setSource('live');
          setError(null);
        }
      } catch (err) {
        console.warn('API fetch failed, using fallback data:', err.message);
        if (!cancelled) {
          setData(FALLBACK_DATA);
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
      const result = await fetchPortfolio(selectedSyndicatorId);
      setData(result);
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
    data,
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
