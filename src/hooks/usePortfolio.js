// src/hooks/usePortfolio.js
import { useState, useEffect } from 'react';
import { fetchPortfolio } from '../api.js';
import { FALLBACK_DATA } from '../fallback-data.js';

export function usePortfolio() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const result = await fetchPortfolio();
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
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const result = await fetchPortfolio();
      setData(result);
      setSource('live');
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return { data, loading, error, source, refresh };
}
