import { useEffect } from "preact/hooks";
import { useLocation } from "wouter-preact";

export const RouteRedirect = ({ to }) => {
  const [, setLocation] = useLocation();
  useEffect(() => {
    // Replace, never push (fix wave F140): a pushed redirect re-triggers on Back.
    setLocation(to, { replace: true });
  }, [to, setLocation]);
  return null;
};
